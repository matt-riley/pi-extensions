// scoring-text.mjs — what Jev is shown when it scores one segment.
//
// A bulky tool result (a build log, a file dump) costs a scoring request most of
// its tokens and says the same thing in its first and last lines: what ran, and
// how it ended. So the copy sent for scoring keeps the head and the tail and
// says how much it left out. Only this copy is trimmed: the segment, the live
// context, the handoff entries, and the coverage and selection requests all keep
// the full text.
//
// Secrets are masked first. A key block cut in two would otherwise stop
// matching the redactor's shapes and leave half of it in the request.

import { redactSecrets } from "../../shared/redact.mjs";

/** A tool result longer than this is trimmed for scoring. */
export const SCORING_TOOL_CHARS = 800;
const HEAD_SHARE = 0.65;
const TOOL_ROLES = new Set(["toolResult", "bashExecution"]);

/** The text of `segment` as it should be scored: trimmed if it is a bulky tool result. */
export function trimForScoring(segment) {
  const text = segment.text;
  if (!TOOL_ROLES.has(segment.role) || text.length <= SCORING_TOOL_CHARS) return text;
  // `homeDir: ""` leaves paths alone; only credentials are masked here.
  const masked = redactSecrets(text, { homeDir: "" }).value;
  if (masked.length <= SCORING_TOOL_CHARS) return masked;
  const head = masked.slice(0, Math.ceil(SCORING_TOOL_CHARS * HEAD_SHARE)).trimEnd();
  const tail = masked.slice(masked.length - (SCORING_TOOL_CHARS - head.length)).trimStart();
  const omitted = masked.length - head.length - tail.length;
  return `${head}\n[… ${omitted} chars trimmed for scoring …]\n${tail}`;
}
