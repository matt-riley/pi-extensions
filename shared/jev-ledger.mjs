// jev-ledger.mjs — local session record of one Jev call.
//
// The entry is what pi.appendEntry stores. It stays in the session and is not
// sent anywhere. Question instructions and criteria can carry user text, so
// the entry keeps the id and the kind only. Answer strings are scrubbed with
// the same literals the request used, in case a choice echoes a key.

import { redactSecrets } from "./redact.mjs";

function finiteNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && !value.trim()) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function questionRecord(id, question) {
  return { id, kind: typeof question?.type === "string" ? question.type : "unknown" };
}

function probabilityRecord(probabilities) {
  if (!probabilities || typeof probabilities !== "object" || Array.isArray(probabilities)) {
    return undefined;
  }
  const out = {};
  for (const [key, value] of Object.entries(probabilities)) {
    const numeric = finiteNumber(value);
    if (numeric === null) continue;
    out[key] = numeric;
  }
  return out;
}

function answerRecord(answer) {
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return null;
  const record = {};
  if (typeof answer.type === "string") record.type = answer.type;
  for (const key of ["noul", "score", "confidence"]) {
    const numeric = finiteNumber(answer[key]);
    if (numeric !== null) record[key] = numeric;
  }
  if (typeof answer.choice === "string") record.choice = answer.choice;
  const probabilities = probabilityRecord(answer.probabilities);
  if (probabilities) record.probabilities = probabilities;
  return record;
}

/**
 * Pi 1.4: appendEntry(customType, data?) persists a custom entry that does not
 * enter the model context. A missing or throwing hook is a host problem, not
 * a reason to fail the judgment the gate is waiting on.
 */
export function appendLedgerEntry(pi, entry) {
  if (typeof pi?.appendEntry !== "function") return;
  try {
    pi.appendEntry("jev-decision", entry);
  } catch {
    // The session could not take the entry. The call still stands.
  }
}

/** The data object stored on a jev-decision entry. No state, no request body. */
export function buildLedgerEntry({
  feature,
  model,
  requestedModel,
  questions,
  answers,
  latencyMs,
  transport,
  redactions,
  privacyRedactions,
  outcome,
  literals,
} = {}) {
  const recordedAnswers = {};
  if (answers && typeof answers === "object") {
    for (const [id, answer] of Object.entries(answers)) {
      recordedAnswers[id] = answerRecord(answer);
    }
  }
  // homeDir "" skips path masking: this scrub is for keys that echoed into an
  // answer, not a second pass over the state.
  const safeAnswers = redactSecrets(recordedAnswers, {
    literals,
    homeDir: "",
    maskEmails: false,
  }).value;
  return {
    feature,
    model,
    requestedModel,
    questions: Object.entries(questions ?? {}).map(([id, question]) => questionRecord(id, question)),
    answers: safeAnswers,
    latencyMs,
    transport,
    redactions,
    privacyRedactions,
    outcome,
  };
}
