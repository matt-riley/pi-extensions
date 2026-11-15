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

const CONCISE_MARKER = "Answer style (concise):";

/**
 * The concise reply style, written in the user's voice because it rides on the
 * user's prompt. Brevity covers the narration only: the messages a person needs
 * whole to act safely are exempt. The opening marker lets a later run find the
 * paragraph again, even when a model has reworded it.
 */
export const CONCISE_STYLE =
  `${CONCISE_MARKER} open with the result and stop once the point is made, with no preamble and no wrap-up. ` +
  "Brevity never applies to a confirmation before a destructive action, to failing test output, or to an error or security warning: give those in full. " +
  "If I ask for more detail, give it.";

/** Drop trailing style paragraphs, the exact one or a reworded one, and nothing else. */
export function stripConciseStyle(text) {
  const paragraphs = String(text ?? "")
    .trimEnd()
    .split(/\n[ \t]*\n/);
  while (paragraphs.length > 0 && paragraphs.at(-1).trimStart().startsWith(CONCISE_MARKER)) {
    paragraphs.pop();
  }
  return paragraphs.join("\n\n");
}

/** The prompt followed by exactly one style paragraph, however many it carried before. */
export function withConciseStyle(text) {
  const prompt = stripConciseStyle(text);
  return prompt ? `${prompt}\n\n${CONCISE_STYLE}` : CONCISE_STYLE;
}

/** `/improve --concise rough prompt`: a leading `--concise` word is the flag, nothing else is. */
export function parseImproveArgs(args) {
  const typed = String(args ?? "").trim();
  const match = /^--concise(?:\s+|$)/.exec(typed);
  return match
    ? { concise: true, prompt: typed.slice(match[0].length).trim() }
    : { concise: false, prompt: typed };
}
