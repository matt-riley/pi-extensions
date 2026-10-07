// judge.mjs — the TypeSafe half of subagents. Three batched, typed judgments:
//
//   preflight  before spawn   is the task complete enough for a child that
//                             cannot see this conversation?
//   triage     after a run    did the result actually answer the task?
//   scope      after a worker did the real diff stay inside the task?
//
// Everything here fails open: no key, a timeout, or a malformed answer means
// "no opinion", never a blocked or altered spawn. Thresholds live in THRESHOLDS.

import { askSystemOne } from "../../shared/systemone.mjs";

const TIMEOUT_MS = "6000";
const MAX_TASK_CHARS = 4000;
const MAX_RESULT_CHARS = 12_000;

const THRESHOLDS = {
  /** Below this, the task leans on context the child cannot see → reject once. */
  selfContained: 0.25,
  /** Above this, a write-capable task hides a design decision → reject once. */
  needsDecision: 0.6,
  /** Below this, nudge the child with a hint instead of rejecting. */
  hasDeliverable: 0.35,
  hasScope: 0.35,
  /** Above this, flag the worker's diff as beyond the task. */
  outOfScope: 0.6,
};

function usable(raw) {
  if (raw === null || raw === undefined || (typeof raw === "string" && !raw.trim())) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

const noul = (answer) => (answer?.type === "noul" ? usable(answer.noul) : null);

const yesNo = (yes, no) => ({ true: yes, false: no });

export function preflightQuestions({ writeCapable }) {
  const questions = {
    self_contained: {
      type: "noul",
      instructions:
        "`task` is handed to an assistant that has NOT seen any earlier conversation, the repository history, or " +
        "other assistants' output. Could it start work using only `task` and the files it can find itself? " +
        "Phrases like 'as discussed', 'the file above', 'fix it', 'the bug' without naming what they refer to " +
        "mean it cannot.",
      criteria: yesNo(
        "Everything needed is stated or named concretely (paths, symbols, errors, goals).",
        "It leans on unstated context: pronouns or references with no referent, 'as above', missing target.",
      ),
    },
    has_deliverable: {
      type: "noul",
      instructions:
        "Does `task` say what the assistant should hand back or produce (a list of findings, a summary, a " +
        "changed file, a yes/no verdict, a report in a given shape)?",
      criteria: yesNo(
        "A concrete output or done-condition is stated.",
        "Only an activity is named ('look into X') with no stated output or stopping point.",
      ),
    },
    has_scope: {
      type: "noul",
      instructions:
        "Does `task` bound where to look or what to touch (named files, directories, symbols, a feature area)?",
      criteria: yesNo(
        "A bounded area is named.",
        "The whole repository or an unbounded topic is implied.",
      ),
    },
  };
  if (writeCapable) {
    questions.needs_decision = {
      type: "noul",
      instructions:
        "`agent_can_edit_files` is true, so `task` will be carried out by an assistant that edits files. Would " +
        "doing it well require an unauthorized public API/compatibility change, new dependency, destructive action, " +
        "or unresolved product decision? Routine local naming and implementation choices within the stated scope are permitted.",
      criteria: yesNo(
        "A real choice is left open that the requester would want to make themselves.",
        "The change is fully specified, or any remaining choice is trivial.",
      ),
    };
  }
  return questions;
}

/**
 * Route preflight answers. `reject` is a message for the orchestrator (or
 * undefined); `hints` are advisory lines appended to the child's task.
 */
export function routePreflight(answers, { writeCapable } = {}) {
  const selfContained = noul(answers?.self_contained);
  const deliverable = noul(answers?.has_deliverable);
  const scope = noul(answers?.has_scope);
  const decision = noul(answers?.needs_decision);

  if (selfContained !== null && selfContained < THRESHOLDS.selfContained) {
    return {
      reject:
        "Task rejected: it seems to rely on context the child cannot see (it starts with a blank slate). " +
        "Rewrite it with concrete paths, symbols, error text and the goal, then resubmit. " +
        "If you believe it is complete, resubmit unchanged and it will run.",
      hints: [],
    };
  }
  if (writeCapable && decision !== null && decision > THRESHOLDS.needsDecision) {
    return {
      reject:
        "Task rejected: it leaves a design decision open (unauthorized public API/compatibility change, dependency addition, product decision, or behaviour) that a " +
        "write-capable child should not make alone. Decide it and state it in the task, then resubmit. " +
        "If the child should choose, resubmit unchanged and it will run.",
      hints: [],
    };
  }
  const hints = [];
  if (deliverable !== null && deliverable < THRESHOLDS.hasDeliverable) {
    hints.push(
      "No output format was specified: end with a short structured report of what you found or did.",
    );
  }
  if (scope !== null && scope < THRESHOLDS.hasScope) {
    hints.push(
      "No scope was specified: state which files and areas you covered and which you skipped.",
    );
  }
  return { reject: undefined, hints };
}

function triageQuestions() {
  return {
    outcome: {
      type: "choice",
      instructions: "Compare `result` with what `task` asked for. Which best describes the result?",
      criteria: {
        answered: "It delivers what the task asked for, with the requested evidence or output.",
        partial:
          "It covers only part of the task, or stops without finishing an obvious next step.",
        blocked: "It reports it could not proceed (missing context, failing check, ambiguity).",
        off_task: "It answers a different question or drifts away from the task.",
      },
    },
  };
}

function scopeQuestions() {
  return {
    out_of_scope: {
      type: "noul",
      instructions:
        "Compare `diff` (what changed in the repository) with `task`. Does the diff change files or behaviour " +
        "the task did not ask for — refactors, renames, formatting, unrelated fixes or extra features?",
      criteria: yesNo(
        "It edits things beyond the task: unrelated files, drive-by cleanups, or additional features.",
        "Every change is needed for the task, even if the change is large.",
      ),
    },
  };
}

async function ask(questions, state, { signal, askImpl = askSystemOne } = {}) {
  try {
    const env = { ...process.env, TYPESAFE_TIMEOUT_MS: TIMEOUT_MS };
    const { answers } = await askImpl({ state, questions, env, signal });
    return answers;
  } catch {
    return undefined; // fail open
  }
}

const rejectedOnce = new Set();

/** Reject an unfit task once; an identical resubmission is trusted. */
export async function preflightTask({ agent, task, writeCapable, signal, askImpl }) {
  const key = `${agent}\0${task}`;
  if (rejectedOnce.has(key)) return { hints: [] };
  const answers = await ask(
    preflightQuestions({ writeCapable }),
    { agent, agent_can_edit_files: writeCapable, task: task.slice(0, MAX_TASK_CHARS) },
    { signal, askImpl },
  );
  const routed = routePreflight(answers, { writeCapable });
  if (routed.reject) rejectedOnce.add(key);
  return routed;
}

/** "answered 0.93"-style line, or undefined when there is no usable opinion. */
export async function triageResult({ agent, task, text, signal, askImpl }) {
  if (!text?.trim()) return undefined;
  const answers = await ask(
    triageQuestions(),
    { agent, task: task.slice(0, MAX_TASK_CHARS), result: text.slice(0, MAX_RESULT_CHARS) },
    { signal, askImpl },
  );
  const answer = answers?.outcome;
  if (answer?.type !== "choice" || typeof answer.choice !== "string") return undefined;
  const confidence = usable(answer.probabilities?.[answer.choice] ?? answer.confidence);
  return confidence === null ? answer.choice : `${answer.choice} (${confidence.toFixed(2)})`;
}

/** Returns a warning line when the diff likely exceeds the task. */
export async function checkDiffScope({ task, diff, signal, askImpl }) {
  if (!diff?.trim()) return undefined;
  const answers = await ask(
    scopeQuestions(),
    { task: task.slice(0, MAX_TASK_CHARS), diff },
    { signal, askImpl },
  );
  const p = noul(answers?.out_of_scope);
  return p !== null && p > THRESHOLDS.outOfScope
    ? `scope check: diff likely goes beyond the task (p=${p.toFixed(2)}) — review it before accepting`
    : undefined;
}
