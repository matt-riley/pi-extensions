// battery.mjs — the questions the router asks, and the mapping back to tools.
//
// One batched TypeSafe call answers these together; code — this file — decides
// what the answers mean. The questions are deliberately about *capability*
// ("will this need to edit files?") rather than about tool names or model
// names, because capability survives tool renames and model churn while
// names do not.
//
// Measured cost of the whole battery: ~650ms and ~780 input / ~160 output
// tokens. The latency is the round trip, not the question count, which is why
// seven questions cost the same as one and the gate in front of them matters
// more than trimming the battery.

/** Probability above which an answer counts as "yes". */
export const ROUTER_THRESHOLDS = {
  needs: 0.5,
  continuation: 0.6,
  /** risk score at or above this wants the stronger model. */
  risk: 1.5,
};

const TASK_CLASSES = new Set(["quick_answer", "code_change", "deep_reason", "research", "ops"]);
export function buildQuestions() {
  return {
    continuation: {
      type: "noul",
      instructions:
        "Does `prompt` continue the work described by `previous_turn`, rather than starting a new task? " +
        "Read `previous_turn.last_response` — the assistant's last message — because a short reply such as " +
        '"push", "yes" or "do it" is usually answering what was just proposed there.',
      criteria: {
        true: "Same task, same files or systems, and the previous turn's context is still relevant.",
        false: "A different task, or a request unrelated to what the previous turn was doing.",
      },
    },
    task_class: {
      type: "choice",
      instructions: "Which single capability does `prompt` primarily need?",
      criteria: {
        quick_answer: "A short factual answer or confirmation, with no file, shell or web work.",
        code_change: "Produce or modify code or files in the working directory.",
        deep_reason:
          "Reason about a design, plan, tradeoff or bug where the answer is not obvious.",
        research: "Find information that is not in the working directory, including from the web.",
        ops: "Run, inspect or fix something by executing commands.",
      },
    },
    needs_files: {
      type: "noul",
      instructions:
        "Will answering `prompt` require reading files in or around `working_directory` — source, configs, " +
        "logs or repository state? When `prompt` is short, resolve what it refers to from " +
        "`previous_turn.last_response` first.",
      criteria: {
        true: "Existing file contents or repository state must be read to answer.",
        false: "The answer needs no file or repository access.",
      },
    },
    needs_edit: {
      type: "noul",
      instructions:
        "Will answering `prompt` require creating or modifying files? Count any code change, config change, " +
        "or document write. When `prompt` is a short reply, judge what it accepts or asks for rather than its " +
        "own wording.",
      criteria: {
        true: "A file must be created or changed for the request to be satisfied.",
        false: "Nothing needs to be written; the answer is text or information.",
      },
    },
    needs_shell: {
      type: "noul",
      instructions:
        "Will answering `prompt` require running shell commands — builds, tests, package managers, git " +
        "operations, commits, pushes, or process and system inspection? When `prompt` is a short reply such as " +
        '"push" or "run it", answer from what it is replying to in `previous_turn.last_response`.',
      criteria: {
        true: "At least one command must run, including read-only commands such as git status or ls.",
        false: "No command needs to run.",
      },
    },
    needs_web: {
      type: "noul",
      instructions:
        "Will answering `prompt` require information that must be fetched from outside this machine — the " +
        "web, documentation sites, or a remote API?",
      criteria: {
        true: "The answer depends on external information that is not in the working directory.",
        false: "Everything needed is already local, or no information is needed.",
      },
    },
    risk: {
      type: "score",
      instructions:
        "How much does getting `prompt` wrong cost, considering that a stronger model is slower and more " +
        "expensive than a weaker one?",
      criteria: [
        "Low: a wrong answer costs seconds and is obvious to spot.",
        "Medium: a wrong answer costs a re-run or a correction, but nothing breaks.",
        "High: a wrong answer could break something, mislead a decision, or waste significant time.",
        "Critical: a wrong answer could cause damage that is hard to undo, or the reasoning is the whole deliverable.",
      ],
    },
  };
}

/** The state the questions read. Named fields, previous turn summarised. */
export function buildRouterState({ prompt, previousTurn, cwd, recentTools } = {}) {
  return {
    prompt: String(prompt ?? "").slice(0, 2000),
    working_directory: cwd ?? null,
    previous_turn: previousTurn
      ? {
          prompt: String(previousTurn.prompt ?? "").slice(0, 600),
          // The reply being answered. Without it, "do it bruv" carries no
          // meaning at all and the judge can only guess.
          last_response: String(previousTurn.lastResponse ?? "").slice(-800),
          tools_used: [...new Set((previousTurn.toolCalls ?? []).map((call) => call.name))].slice(
            0,
            20,
          ),
          failed_calls: (previousTurn.toolCalls ?? []).filter((call) => call.isError).length,
        }
      : null,
    recent_tools: Array.isArray(recentTools) ? recentTools.slice(-20) : [],
  };
}

// Number(null) is 0, which would read as a confident "no" — the direction a
// router must not fail in, because "no shell needed" removes a tool.
function usableNumber(raw) {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string" && !raw.trim()) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function noulValue(answer) {
  if (!answer || answer.type !== "noul") return null;
  return usableNumber(answer.noul);
}

function scoreValue(answer) {
  if (!answer || answer.type !== "score") return null;
  return usableNumber(answer.score);
}

function choiceValue(answer) {
  if (!answer || answer.type !== "choice") return null;
  const value = typeof answer.choice === "string" ? answer.choice.trim() : "";
  return TASK_CLASSES.has(value) ? value : null;
}

/**
 * Answers → the configuration the code will apply.
 *
 * Returns `groups: null` when no usable answer came back at all: an absent
 * judgment is not the same as a negative one, and the caller must decide the
 * fallback (the extension keeps the current configuration).
 */
export function routeFromAnswers(answers, thresholds = ROUTER_THRESHOLDS) {
  const continuation = noulValue(answers?.continuation);
  const files = noulValue(answers?.needs_files);
  const edit = noulValue(answers?.needs_edit);
  const shell = noulValue(answers?.needs_shell);
  const web = noulValue(answers?.needs_web);
  const risk = scoreValue(answers?.risk);
  const taskClass = choiceValue(answers?.task_class);

  const usable = [continuation, files, edit, shell, web, risk].some((value) => value !== null);
  if (!usable) {
    return { groups: null, taskClass, risk, continuation, signals: { files, edit, shell, web } };
  }

  const groups = new Set();
  if (files !== null && files >= thresholds.needs) groups.add("read");
  if (edit !== null && edit >= thresholds.needs) {
    groups.add("edit");
    // Writing without reading is rare enough that the exception is not worth
    // the risk of a turn that cannot see the file it is about to change.
    groups.add("read");
  }
  if (shell !== null && shell >= thresholds.needs) groups.add("shell");
  if (web !== null && web >= thresholds.needs) groups.add("web");

  return {
    groups,
    taskClass,
    risk,
    continuation,
    wantsStrongModel: risk !== null && risk >= thresholds.risk,
    signals: { files, edit, shell, web },
  };
}
