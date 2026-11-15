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

/**
 * The concise reply style, written in the user's voice because it rides on the
 * user's prompt. Brevity covers the narration only: anything the person needs in
 * full to make a safe decision keeps its detail.
 */
export const CONCISE_STYLE =
  "Reply style: result first. Put what happened, or the answer, in your opening sentence, with no preamble and no closing recap. " +
  "Keep it short, and give full detail when I ask. " +
  "Never shorten a confirmation before a destructive action, failing test output or an error message, or a security warning: those keep their full content.";

/** Append the concise style to a prompt, once. */
export function withConciseStyle(text) {
  const prompt = String(text ?? "").trimEnd();
  return prompt.includes(CONCISE_STYLE) ? prompt : `${prompt}\n\n${CONCISE_STYLE}`;
}

/** `/improve --concise rough prompt`: a leading `--concise` word is the flag, nothing else is. */
export function parseImproveArgs(args) {
  const typed = String(args ?? "").trim();
  const match = /^--concise(?:\s+|$)/.exec(typed);
  return match
    ? { concise: true, prompt: typed.slice(match[0].length).trim() }
    : { concise: false, prompt: typed };
}
