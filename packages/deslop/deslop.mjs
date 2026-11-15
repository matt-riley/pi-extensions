// deslop.mjs — what happens after one edit: which text the agent added, whether
// it carries machine-writing patterns, and what the edit result should say.
//
// Two passes over a prose file, both riding on the `tool_result` of `edit` or
// `write`:
//
//   first pass   the added text is scanned; findings TypeSafe confirms (or, with
//                no judge, findings that include a high-severity sign) become a
//                note on the edit result asking for a rewrite.
//   second pass  the agent's rewrite of a flagged file is rechecked and its
//                meaning compared with the flagged text. A clean rewrite that
//                says the same thing is silent.
//
// At most MAX_REPORTS notes per file per user prompt. A third would be the
// extension arguing with a sentence the agent has already decided to keep.

import { isAbsolute, relative, resolve, sep } from "node:path";

import { addedFindings, findSlop, formatFindings, worthReporting } from "./patterns.mjs";
import { verifyFindings, verifyRewrite } from "./verify.mjs";

const EDIT_TOOLS = new Set(["edit", "write"]);
const PROSE_FILE = /\.(md|mdx|markdown|txt|rst|adoc)$/i;
export const MAX_REPORTS = 2;

export function createDeslopState() {
  return { pending: new Map(), reports: new Map() };
}

export function resetDeslopState(state) {
  state.pending.clear();
  state.reports.clear();
}

/** The edited path relative to the session cwd, or null when it is outside it. */
function repoRelativePath(cwd, path) {
  if (typeof cwd !== "string" || !cwd) return path;
  const rel = relative(resolve(cwd), resolve(cwd, path));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel;
}

/**
 * The text a tool call replaced and the text it wrote.
 *
 * `write` has no before: the tool result does not carry the old file, and the
 * whole content is the agent's. `edit` carries both sides of every replacement,
 * in pi's `edits` array or the single `oldText`/`newText` form.
 */
export function changeOf(toolName, input) {
  if (toolName === "write") {
    return typeof input?.content === "string" ? { before: "", after: input.content } : null;
  }
  const edits = Array.isArray(input?.edits)
    ? input.edits
    : typeof input?.newText === "string"
      ? [{ oldText: input.oldText, newText: input.newText }]
      : [];
  const usable = edits.filter((edit) => typeof edit?.newText === "string");
  if (usable.length === 0) return null;
  return {
    before: usable
      .map((edit) => (typeof edit.oldText === "string" ? edit.oldText : ""))
      .join("\n\n"),
    after: usable.map((edit) => edit.newText).join("\n\n"),
  };
}

function evidence(judged) {
  const numbers = Object.entries(judged?.signals ?? {})
    .filter(([, value]) => typeof value === "number" && Number.isFinite(value))
    .map(([name, value]) => `${name} ${value.toFixed(2)}`)
    .join(" · ");
  return numbers ? ` (${numbers})` : "";
}

/** The note for a first pass. Advice, in the source skills' own terms. */
function findingsNote(path, findings, judged, verify) {
  const verified = judged?.judged
    ? `TypeSafe reads them as making the text worse for its reader${evidence(judged)}.`
    : verify
      ? "TypeSafe was unavailable, so this is the pattern check alone."
      : "TypeSafe verification is switched off, so this is the pattern check alone.";
  return [
    `deslop: the text this edit added to ${path} carries machine-writing patterns. ${verified}`,
    formatFindings(findings),
    "Rewrite the flagged sentences so they say the same thing plainly. This is advice: " +
      "keep any sentence that is already the clearest way to say it, and do not swap a " +
      "flagged phrase for its nearest neighbour.",
  ].join("\n");
}

/** The note for a second pass, or null when the rewrite passed. */
function rewriteNote(path, judged, remaining, last) {
  const closing = last ? " This is the last deslop note for this file." : "";
  if (judged.verdict === "meaning_changed") {
    return (
      `deslop: TypeSafe reads the rewrite of ${path} as changing what the text says` +
      `${evidence(judged)}. Restore the facts, steps and caveats the earlier version carried; ` +
      `removing a pattern is not a reason to change the claim.${closing}`
    );
  }
  if (judged.verdict !== "still_slop") return null;
  if (remaining.length > 0) {
    return [
      `deslop: the rewrite of ${path} still carries these patterns${evidence(judged)}.`,
      formatFindings(remaining),
      `Fix them, or leave a sentence that is already clear.${closing}`,
    ].join("\n");
  }
  return (
    `deslop: TypeSafe still reads the rewrite of ${path} as formula prose${evidence(judged)}. ` +
    "Check that a removed pattern was not replaced by its nearest neighbour, such as a " +
    `negation moved into "rather than".${closing}`
  );
}

/**
 * Handle one finished tool call. Returns the note to append to its result, or
 * null. `verify: false` skips TypeSafe and leaves the deterministic check.
 */
export async function observeEdit(
  state,
  { toolName, input, isError, cwd } = {},
  { verify = true, judgeFindings = verifyFindings, judgeRewrite = verifyRewrite } = {},
) {
  if (!EDIT_TOOLS.has(toolName) || isError === true) return null;
  const raw = typeof input?.path === "string" ? input.path : null;
  const path = raw ? repoRelativePath(cwd, raw) : null;
  if (!path || !PROSE_FILE.test(path)) return null;
  const change = changeOf(toolName, input);
  if (!change || !change.after.trim()) return null;

  const reports = state.reports.get(path) ?? 0;
  if (reports >= MAX_REPORTS) return null;
  const pending = state.pending.get(path);
  const rewrites =
    pending &&
    (toolName === "write" || findSlop(change.before).some((item) => pending.ids.has(item.id)));

  if (rewrites) {
    const before = toolName === "write" ? pending.text : change.before;
    const remaining = findSlop(change.after);
    const remainingReportable = worthReporting(remaining);
    const judged = verify
      ? await judgeRewrite({ path, before, after: change.after, remainingReportable })
      : {
          verdict: remainingReportable ? "still_slop" : "clean",
          judged: false,
          signals: {},
        };
    if (judged.verdict === "clean") {
      state.pending.delete(path);
      return null;
    }
    state.reports.set(path, reports + 1);
    pending.text = change.after;
    for (const item of remaining) pending.ids.add(item.id);
    const shown = remainingReportable ? remaining : [];
    return rewriteNote(path, judged, shown, reports + 1 >= MAX_REPORTS);
  }

  const findings = addedFindings(change.after, change.before);
  if (!worthReporting(findings)) return null;
  const judged = verify
    ? await judgeFindings({ path, text: change.after, findings })
    : { judged: false, verdict: null, signals: {} };
  if (judged.verdict === "dismissed") return null;
  // Unverified, a low or medium sign is too weak to interrupt an edit for.
  if (!judged.judged && !findings.some((item) => item.severity === "high")) return null;
  state.reports.set(path, reports + 1);
  state.pending.set(path, {
    text: change.after,
    ids: new Set([...(pending?.ids ?? []), ...findings.map((item) => item.id)]),
  });
  return findingsNote(path, findings, judged, verify);
}
