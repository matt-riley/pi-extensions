// ask-gate.mjs — a question the context already answers does not deserve a dialog.
//
// The plan-mode prompt already forbids asking what read-only exploration can
// settle, and the model still asks. This is the enforcement point: the tool
// itself, where a question cannot be fired without passing through it.
//
// Conservative on purpose. Any doubt — a preference, a cost, an interface, a
// deletion, thin confidence, no recommendation to check against — asks the
// user exactly as before. The point is to remove the dialogs whose answer was
// already in the repository, not to guess at the hard ones.

import { askSystemOne, validateRequest } from "../../shared/systemone.mjs";

/** The escape hatch. Without it, a model that must choose invents. */
export const ASK_USER = "ask_user";
/** Both the pick and the "context determines it" reading must clear this. */
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
    criteria[String(option)] = `use "${option}"`;
  }
  criteria[ASK_USER] = "the context does not settle this: the user must decide";
  return {
    pick: {
      type: "choice",
      instructions:
        "Which option does the context in `request` and `question` support for this project? " +
        "Choose ask_user unless the repository, the request or the recommended answer settles it.",
      criteria,
    },
    determined: {
      type: "noul",
      instructions:
        "Do `question` and `options` describe something the context in `request` settles — a fact, a " +
        "convention, or the agent's own `recommended` answer — rather than a preference, a tradeoff only " +
        "the user can weigh, or something still to be discovered?",
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
  const determined = answers?.determined;
  return {
    pick: known ? label : null,
    confidence: known
      ? (usableNumber(answer?.confidence) ?? usableNumber(answer?.probabilities?.[label]))
      : null,
    determined: determined?.type === "noul" ? usableNumber(determined.noul) : null,
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
  const confidence = judged.confidence ?? 0;
  const determined = judged.determined ?? 0;
  if (confidence < CONFIDENCE_FLOOR || determined < CONFIDENCE_FLOOR) {
    return { answer: null, reason: `below the ${CONFIDENCE_FLOOR} line` };
  }
  return {
    answer: pick,
    reason: `${pick} at ${confidence.toFixed(2)} confidence, context-determined at ${determined.toFixed(2)}`,
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
