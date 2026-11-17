// verdict.mjs — a verifier's verdict bound to the patch it covered.
//
// subagents records one session entry per finished verifier; watch_pr reads the
// newest and says whether the PR's patch is still the one that was verified.
// A verdict covers a patch, not a SHA: a rebase changes every SHA while the
// patch stays the same, and an amended commit keeps a branch name while the
// patch changes.

import { defaultBase, patchId } from "./revision.mjs";

export const VERDICT_ENTRY = "verifier-verdict";

const VERDICTS = ["partially verified", "verified", "failed"];

/** The verdict word under the verifier's `## Verdict` heading, or null. */
export function parseVerifierVerdict(text) {
  const body = String(text ?? "");
  const heading = /^#{1,6}\s*Verdict\s*$/im.exec(body);
  if (!heading) return null;
  const line = body
    .slice(heading.index + heading[0].length)
    .split("\n")
    .find((item) => item.trim());
  const words = String(line ?? "")
    .toLowerCase()
    .replace(/[*_`]/g, "");
  return VERDICTS.find((verdict) => words.trimStart().startsWith(verdict)) ?? null;
}

/**
 * The entry to record when a verifier finishes: its verdict, the commit it
 * ended on, and the patch id of the working tree against the default branch.
 */
export async function verdictEntry({ text, cwd, head, id, now = new Date() }) {
  const base = await defaultBase(cwd);
  return {
    verdict: parseVerifierVerdict(text) ?? "unreadable",
    head: head ?? null,
    patchId: base ? await patchId(cwd, base) : null,
    base,
    at: now.toISOString(),
    id,
  };
}

/** Patch id of a PR from its base branch to its head commit, using local refs only. */
export async function prPatchId(cwd, pr) {
  const head = String(pr?.headRefOid ?? "");
  const base = String(pr?.baseRefName ?? "");
  if (!/^[0-9a-f]{7,40}$/i.test(head) || !base) return null;
  for (const ref of [`origin/${base}`, base]) {
    const id = await patchId(cwd, ref, head);
    if (id) return id;
  }
  return null;
}

/** The newest verifier verdict entry on a session branch, or null. */
export function latestVerdict(branch) {
  const list = Array.isArray(branch) ? branch : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const entry = list[i];
    if (entry?.type === "custom" && entry.customType === VERDICT_ENTRY && entry.data)
      return entry.data;
  }
  return null;
}

/**
 * One report line comparing the newest verdict with the PR's current patch id.
 * Separate from watch_pr's five verdicts: `ready` stays GitHub's view.
 */
export function verifiedLine(verdict, currentPatchId) {
  if (!verdict) return "verified: no verdict recorded";
  const at = String(verdict.head ?? "").slice(0, 12) || "an unknown commit";
  if (verdict.verdict !== "verified")
    return `verified: no (latest verifier verdict was ${verdict.verdict ?? "unreadable"} at ${at})`;
  if (!verdict.patchId)
    return `verified: unknown (no patch id was recorded with the verdict at ${at})`;
  if (!currentPatchId)
    return `verified: unknown (could not compute this PR's patch id locally; fetch its head and base)`;
  return verdict.patchId === currentPatchId
    ? `verified: yes (patch unchanged since ${at})`
    : `verified: stale (patch changed since ${at})`;
}
