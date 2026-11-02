// nudge.mjs — the diagnosis-check reminder.
//
// A failing command is the moment a wrong-but-plausible root cause gets
// written down. This turns that moment into a prompt: name the cause, then ask
// TypeSafe whether the evidence supports it. Plain .mjs so node --test covers
// the state machine without a TS loader (see AGENTS.md).

export const DIAGNOSIS_TOOL = "typesafe_ask";

export const NUDGE_TEXT = [
  "Diagnosis check: name the root cause in one line, then ask `typesafe_ask`",
  "whether the evidence you are about to cite actually supports it.",
  "Plausible is not the same as supported.",
].join(" ");

/**
 * Tools that cannot change the working tree. `codemode`, `bash`, `write` and
 * `edit` are deliberately absent: any of them can mutate, and a mutating call
 * ends the run measured below.
 */
const READ_ONLY_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "repo_map",
  "code_search",
  "file_outline",
  "find_definition",
  "read_relevant",
  "skill_select",
  "lore_recall",
  "lore_search",
  "tool_search",
  "terminal_read",
  "terminal_list",
]);

/**
 * Consecutive read-only calls that mean "say where you are". The 2026-10-20
 * `infra` session confirmed a diagnosis for dozens of reads and had fixed
 * nothing when Matt asked whether it was going in circles; no failing check
 * ever armed `diagnosis_checkpoint`. The number itself is a guess, not a
 * measurement — raise it if it interrupts ordinary read-heavy work.
 */
export const STALL_NUDGE_AT = 40;

export function stallText(count) {
  return [
    `Stall check: ${count} read-only calls since the last change.`,
    "State the measured position and the single next action in one line,",
    "then change something or ask Matt.",
  ].join(" ");
}

/** Fresh state; reset per session so a new session starts clean. */
export function createNudgeState() {
  return {
    unaddressed: false,
    nudged: false,
    seen: new Set(),
    judged: 0,
    readOnly: 0,
    stalled: false,
  };
}

export function resetNudgeState(state) {
  state.unaddressed = false;
  state.nudged = false;
  state.seen.clear();
  state.judged = 0;
  state.readOnly = 0;
  state.stalled = false;
  return state;
}

/**
 * Observe one finished tool call.
 *
 * - the diagnosis tool itself clears the streak (the check happened)
 * - a failure arms the streak and nudges once per streak
 * - successes are ignored: a passing `grep` does not mean the failing test
 *   stopped failing
 * - an unbroken run of read-only calls also nudges once: long silent
 *   investigation is the failure mode a failing check cannot see
 *
 * @returns {{ nudge: boolean, text?: string, unaddressed: boolean, stallText?: string }}
 */
export function observeToolResult(state, { toolName, isError } = {}) {
  const stall = observeReadOnlyRun(state, toolName);
  if (toolName === DIAGNOSIS_TOOL) {
    state.unaddressed = false;
    state.nudged = false;
    return withStall({ nudge: false, unaddressed: false }, stall);
  }
  if (isError !== true) {
    return withStall({ nudge: false, unaddressed: state.unaddressed }, stall);
  }
  state.unaddressed = true;
  if (state.nudged) {
    return withStall({ nudge: false, unaddressed: true }, stall);
  }
  state.nudged = true;
  return withStall({ nudge: true, text: NUDGE_TEXT, unaddressed: true }, stall);
}

function withStall(result, stall) {
  return stall ? { ...result, stallText: stall } : result;
}

/**
 * Count a run of read-only calls. Any other tool ends the run, so only an
 * uninterrupted stretch of reading trips it, and it speaks once per run.
 *
 * @returns {string | undefined} the reminder, on the call that reaches the threshold
 */
function observeReadOnlyRun(state, toolName) {
  if (!READ_ONLY_TOOLS.has(toolName)) {
    state.readOnly = 0;
    state.stalled = false;
    return undefined;
  }
  state.readOnly += 1;
  if (state.stalled || state.readOnly < STALL_NUDGE_AT) {
    return undefined;
  }
  state.stalled = true;
  return stallText(state.readOnly);
}

/** Append the reminder as its own content block, leaving the result intact. */
export function appendNudge(content, text) {
  if (!Array.isArray(content)) {
    return content;
  }
  return [...content, { type: "text", text }];
}
