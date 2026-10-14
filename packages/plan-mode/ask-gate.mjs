// ask-gate.mjs — a question the context already answers does not deserve a dialog.
//
// The plan-mode prompt already forbids asking what read-only exploration can
// settle, and the model still asks. This is the enforcement point: the tool
// itself, where a question cannot be fired without passing through it.
//
// The decision is about the agent, not the user: if an independent reading of
// the question lands on the option the agent itself recommends, the dialog was
// going to confirm an answer nobody was in doubt about. Everything else — a
// preference, a cost, an interface, a deletion, no recommendation, a reading
// that disagrees or is unsure — asks the user exactly as before.
//
// A first version asked the judge whether "the context settles this" and got
// 0.32 and 0.57 on the most inferable questions, which was the right answer to
// the wrong question: one line of request is not context. Reading the
// recommendation needs no more than the tool already has.

import { askSystemOne, validateRequest } from "../../shared/systemone.mjs";

/** The escape hatch. Without it, a model that must choose invents. */
export const ASK_USER = "ask_user";
/** The reading of the recommendation must clear this. */
const CONFIDENCE_FLOOR = 0.9;
const DEFAULT_TIMEOUT_MS = 2500;
const MAX_CHARS = 2000;

/** Questions that are the user's to answer, whatever the judge thinks. */
const ALWAYS_ASK = [
  [
    /\b(delete|deleting|remove|removing|drop|dropping|wipe|destroy|overwrite|revert|squash|force[- ]push)\b/i,
    "it can destroy or rewrite something",
  ],
  [
    /\b(add|install|introduce|swap|replace)\b[^.]*\b(dependency|dependencies|package|library|framework|service|runtime|database|provider)\b/i,
    "it changes what the project depends on",
  ],
  [/\b(cost|costs|price|pricing|month|billing|budget|paid|subscription)\b/i, "it spends money"],
  [
    /\b(deploy|publish|remote|production|prod|public|upstream|other people|team)\b/i,
    "it leaves this machine or affects other people",
  ],
  [
    /\b(breaking|rename|renaming|deprecat|migrat|lockfile|schema|interface|api)\b/i,
    "it changes an interface others rely on",
  ],
  [
    /\b(prefer|preference|taste|style|naming|colour|color|theme|ux|look and feel|dark mode|light mode)\b/i,
    "it is a matter of preference",
  ],
  [
    /\b(auth|credential|secret|token|password|permission|access)\b/i,
    "it touches access or credentials",
  ],
];

function clip(text) {
  const value = String(text ?? "");
  return value.length > MAX_CHARS ? value.slice(0, MAX_CHARS) : value;
}

/** The reason this question is the user's to answer, or null. */
export function alwaysAsk(question) {
  const text = String(question ?? "");
  for (const [pattern, reason] of ALWAYS_ASK) {
    if (pattern.test(text)) {
      return reason;
    }
  }
  return null;
}

export function buildGateQuestions(options = []) {
  const criteria = {};
  for (const option of options) {
    criteria[String(option)] = `${option}`;
  }
  criteria[ASK_USER] = "the recommendation names none of these, or not plainly enough to read";
  return {
    pick: {
      type: "choice",
      instructions:
        "Which one option does the agent's own `recommended` answer name for `question`, read " +
        "against `request`? Choose ask_user unless one of the criteria is plainly what the " +
        "recommendation says.",
      criteria,
    },
  };
}

function usableNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** Read the answers without trusting their shape, or the option list. */
export function readGate(answers, options = []) {
  const answer = answers?.pick;
  const label = answer?.type === "choice" ? String(answer.choice ?? "") : "";
  const known = label === ASK_USER || (Array.isArray(options) && options.includes(label));
  return {
    pick: known ? label : null,
    confidence: known
      ? (usableNumber(answer?.confidence) ?? usableNumber(answer?.probabilities?.[label]))
      : null,
  };
}

/** The answer to hand the agent, or nothing so the dialog happens. */
export function decideGate({ question, options, recommended } = {}, judged = {}) {
  if (judged?.unavailable) {
    return { answer: null, reason: "no judgment available" };
  }
  const veto = alwaysAsk(question);
  if (veto) {
    return { answer: null, reason: veto };
  }
  if (!String(recommended ?? "").trim()) {
    return { answer: null, reason: "no recommendation to check the inference against" };
  }
  const pick = judged?.pick;
  if (!pick || pick === ASK_USER || !Array.isArray(options) || !options.includes(pick)) {
    return { answer: null, reason: "the question is not settled" };
  }
  // The recommendation is the evidence. An independent reading that lands on
  // the same option confirms what the dialog would have confirmed; a reading
  // that lands elsewhere is a disagreement worth a human, not a coin toss.
  if (pick !== String(recommended).trim()) {
    return {
      answer: null,
      reason: `the reading says "${pick}", the recommendation says otherwise`,
    };
  }
  const confidence = judged.confidence ?? 0;
  if (confidence < CONFIDENCE_FLOOR) {
    return { answer: null, reason: `the reading is only ${confidence.toFixed(2)} sure` };
  }
  return {
    answer: pick,
    reason: `the recommendation reads plainly as "${pick}" (${confidence.toFixed(2)})`,
  };
}

/** Ask whether the context settles this. Every failure means "ask the user". */
export async function judgeQuestion({
  question,
  options = [],
  recommended,
  request,
  ask = askSystemOne,
  env,
  model,
  signal,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const state = {
    request: clip(request),
    question: clip(question),
    options: options.map(clip),
    recommended: clip(recommended),
  };
  const questions = buildGateQuestions(options);
  try {
    validateRequest({ state, questions });
    const result = await ask({
      state,
      questions,
      env,
      model,
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    });
    return { ...readGate(result?.answers, options), unavailable: false };
  } catch (error) {
    return {
      pick: null,
      confidence: null,
      determined: null,
      unavailable: true,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
