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

/** Fresh state; reset per session so a new session starts clean. */
export function createNudgeState() {
  return { unaddressed: false, nudged: false };
}

export function resetNudgeState(state) {
  state.unaddressed = false;
  state.nudged = false;
  return state;
}

/**
 * Observe one finished tool call.
 *
 * - the diagnosis tool itself clears the streak (the check happened)
 * - a failure arms the streak and nudges once per streak
 * - successes are ignored: a passing `grep` does not mean the failing test
 *   stopped failing
 *
 * @returns {{ nudge: boolean, text?: string, unaddressed: boolean }}
 */
export function observeToolResult(state, { toolName, isError } = {}) {
  if (toolName === DIAGNOSIS_TOOL) {
    state.unaddressed = false;
    state.nudged = false;
    return { nudge: false, unaddressed: false };
  }
  if (isError !== true) {
    return { nudge: false, unaddressed: state.unaddressed };
  }
  state.unaddressed = true;
  if (state.nudged) {
    return { nudge: false, unaddressed: true };
  }
  state.nudged = true;
  return { nudge: true, text: NUDGE_TEXT, unaddressed: true };
}

/** Append the reminder as its own content block, leaving the result intact. */
export function appendNudge(content, text) {
  if (!Array.isArray(content)) {
    return content;
  }
  return [...content, { type: "text", text }];
}
