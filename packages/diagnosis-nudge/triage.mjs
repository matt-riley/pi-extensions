// triage.mjs — what kind of failure was that, and did it leak a secret?
//
// A failing command is also where the retry decision gets made. The
// deterministic half of this package nudges the diagnosis; this half asks Jev
// what the failure was, so a code bug does not get retried unchanged and a
// transient blip does not get "fixed" by rewriting correct code.
//
// Plain .mjs so node --test covers the mapping without a TS loader.

import { askSystemOne, validateRequest } from "../../shared/systemone.mjs";

/** What the question sees. The published protocol ships the first 2000. */
const OUTPUT_CHARS = 2000;
/** Below this the class is a coin flip, and wrong advice is worse than none. */
const CONFIDENCE_FLOOR = 0.6;
const LEAK_THRESHOLD = 0.9;
/** A failing command must not gain a long wait: this rides on the result. */
const DEFAULT_TIMEOUT_MS = 2500;
/** A loop that fails 200 times does not deserve 200 judgments. */
export const MAX_TRIAGE_PER_SESSION = 30;

const CLASSES = {
  no_failure: "the command succeeded or the output shows no error",
  transient: "network, rate limit, lock, or timing problem that may pass if retried unchanged",
  environment: "missing tool, wrong version, port in use, or other machine setup problem",
  code_bug: "a defect in the project's own code: compile error, failing test, exception",
  permission: "access denied, authentication failed, or insufficient privileges",
  user_error: "wrong arguments, wrong directory, typo, or misuse of the command",
};

/** What to do about each class. Silence is a valid answer: `no_failure` has none. */
export const ADVICE = {
  transient: "transient — retry the same command once, unchanged",
  environment: "environment — fix the machine (install, version, port), not the code",
  code_bug: "code bug — fix the code; retrying it unchanged will not help",
  permission: "permission — do not retry unchanged; ask the user how to proceed",
  user_error: "invocation — fix the arguments or the directory, then retry",
};

export const LEAK_WARNING =
  "Secret in the output: do not repeat the value in a reply, a file, or another command — refer to it by name, and tell the user it appeared.";

export function buildFailureQuestions() {
  return {
    failure_class: {
      type: "choice",
      instructions: "What kind of failure does `output` show for `action`, run in `cwd`?",
      criteria: { ...CLASSES },
    },
    leaks_secret: {
      type: "noul",
      instructions:
        "Does `output` contain a credential, private key, token, or password value — even a truncated one — " +
        "that a coding agent must not repeat in a reply, a file, or another command?",
    },
  };
}

function usableNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function clip(text, limit = OUTPUT_CHARS) {
  const value = String(text ?? "");
  return value.length > limit
    ? `${value.slice(0, limit)}…[${value.length - limit} chars elided]`
    : value;
}

/** Read the two answers without trusting their shape. */
export function readTriage(answers) {
  const answer = answers?.failure_class;
  const label = answer?.type === "choice" ? String(answer.choice ?? "") : "";
  const known = Object.hasOwn(CLASSES, label);
  const leak = answers?.leaks_secret;
  return {
    failureClass: known ? label : null,
    confidence: known
      ? (usableNumber(answer?.confidence) ?? usableNumber(answer?.probabilities?.[label]))
      : null,
    leaksSecret: leak?.type === "noul" ? usableNumber(leak.noul) : null,
  };
}

/** The line that goes on the result, or nothing. */
export function triageText(
  triage,
  { confidenceFloor = CONFIDENCE_FLOOR, leakThreshold = LEAK_THRESHOLD } = {},
) {
  const parts = [];
  if ((triage?.leaksSecret ?? 0) >= leakThreshold) {
    parts.push(LEAK_WARNING);
  }
  const advice = ADVICE[triage?.failureClass];
  const confidence = triage?.confidence;
  if (
    advice &&
    (confidence === null || confidence === undefined || confidence >= confidenceFloor)
  ) {
    parts.push(`Failure triage: ${advice}.`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

/** The key a repeated failure shares: what the question sees, not the whole log. */
export function memoKeyFor({ toolName, output } = {}) {
  return `${toolName ?? "unknown"}\u0000${clip(output)}`;
}

/** Spend a judgment on this failure? Once per distinct failure, up to a cap. */
export function shouldTriage(state, key, cap = MAX_TRIAGE_PER_SESSION) {
  if (!state?.seen || state.seen.has(key)) return false;
  if ((state.judged ?? 0) >= cap) return false;
  state.seen.add(key);
  state.judged = (state.judged ?? 0) + 1;
  return true;
}

/**
 * Ask what the failure was. Every failure of the ask is a missing
 * classification, never a lost tool result.
 */
export async function judgeFailure({
  action,
  cwd,
  toolName,
  output,
  ask = askSystemOne,
  env,
  model,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const state = {
    tool: String(toolName ?? "unknown"),
    action: clip(action),
    cwd: String(cwd ?? ""),
    output: clip(output),
  };
  const questions = buildFailureQuestions();
  try {
    validateRequest({ state, questions });
    const result = await ask({
      state,
      questions,
      env,
      model,
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    });
    return { ...readTriage(result?.answers), unavailable: false };
  } catch (error) {
    return {
      failureClass: null,
      confidence: null,
      leaksSecret: null,
      unavailable: true,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
