// lib.mjs — pure helpers for the on-demand /improve command.

import { messageText } from "../../shared/message-text.mjs";

const MAX_REWRITE_LENGTH = 12_000;

/** Return the most recent actual user message from a pi session branch. */
export function extractLastUserPrompt(branch) {
  const entries = Array.isArray(branch) ? branch : [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = entries[index]?.message ?? entries[index];
    if (message?.role !== "user") continue;
    const text = messageText(message.content).trim();
    if (text) return text;
  }
  return "";
}

/** Reject obviously unusable local-model output before it reaches the agent. */
export function validateCandidate(original, candidate, { maxLength = MAX_REWRITE_LENGTH } = {}) {
  const source = String(original ?? "").trim();
  const text = String(candidate ?? "").trim();
  if (!source) return { ok: false, reason: "no original prompt" };
  if (!text) return { ok: false, reason: "empty rewrite" };
  if (text.length > maxLength) return { ok: false, reason: "rewrite is too long" };
  if (text.includes("\u0000")) return { ok: false, reason: "rewrite contains a control character" };
  return { ok: true, text, changed: text !== source };
}

export function usableNoul(answer) {
  if (answer?.type !== "noul") return null;
  const value = Number(answer.noul);
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : null;
}
