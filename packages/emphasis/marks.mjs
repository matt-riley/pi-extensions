// marks.mjs — what emphasis learns from the collection before it draws a reply.
//
// Two readings, both display-only and both quiet when they cannot tell:
//   - whether the reply was written over code edits no check covered, from the
//     spans done-gate publishes (shared/evidence-state.mjs);
//   - which paths named in the reply are missing under the session's cwd, from
//     the existence check subagents already use (shared/stalepaths.mjs). A
//     reply often shortens a path (`decision-rows/rows.mjs` for
//     packages/decision-rows/rows.mjs), so a path that ends a file git knows
//     about is not missing.
//
// pi runs a transformer on every streaming update, resize and restored message,
// so the path check is cached and skipped while a reply is still streaming.

import { execFileSync } from "node:child_process";

import { uncheckedEditsAt } from "../../shared/evidence-state.mjs";
import { findStalePaths } from "../../shared/stalepaths.mjs";

const NONE = new Set();
const MAX_ENTRIES = 64;
const TTL_MS = 2000;
const FILES_TTL_MS = 10_000;

/** Tracked and untracked files under `cwd`, relative to it. Empty when git cannot say. */
function gitFiles(cwd) {
  try {
    const out = execFileSync(
      "git",
      ["-C", cwd, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      {
        encoding: "utf8",
        timeout: 2000,
        maxBuffer: 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    return out.split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

/** Whether `written` is the tail of a known file: `a/b.mjs` matches `x/a/b.mjs`. */
function endsAFile(written, files) {
  if (/^(?:\/|\.{1,2}\/|~\/)/.test(written)) return false;
  const tail = "/" + written;
  return files.some((file) => file.endsWith(tail));
}

/**
 * A cached `findStalePaths` keyed by cwd and text. An entry is reused for
 * `ttlMs`, so a file created a moment later is noticed on the next render.
 */
export function createStaleLookup({
  find = findStalePaths,
  listFiles = gitFiles,
  now = Date.now,
  ttlMs = TTL_MS,
} = {}) {
  const cache = new Map();
  let listed = { cwd: undefined, at: -Infinity, files: [] };
  // Listed only when a path looks missing, and reused across replies for a while.
  const filesFor = (cwd) => {
    if (listed.cwd !== cwd || now() - listed.at >= FILES_TTL_MS)
      listed = { cwd, at: now(), files: listFiles(cwd) };
    return listed.files;
  };
  return (markdown, cwd) => {
    if (!cwd || !markdown.includes("`")) return NONE;
    const key = cwd + "\0" + markdown;
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.paths;
    const missing = find(markdown, cwd);
    const paths = new Set(
      missing.length ? missing.filter((written) => !endsAFile(written, filesFor(cwd))) : missing,
    );
    cache.delete(key);
    cache.set(key, { at: now(), paths });
    if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
    return paths;
  };
}

/** When a message was written: its saved timestamp, or now for a live one. */
export function writtenAt(context, now = Date.now()) {
  const at = Date.parse(context?.timestamp ?? "");
  return Number.isFinite(at) ? at : now;
}

/**
 * The marks for one assistant render. `uncheckedAt` defaults to done-gate's
 * published spans; an unknown answer (done-gate absent) marks nothing.
 */
export function replyMarks(
  markdown,
  context,
  { cwd, stale, evidence = true, paths = true, uncheckedAt = uncheckedEditsAt } = {},
) {
  return {
    unchecked: evidence && uncheckedAt(writtenAt(context)) === true,
    stale: paths && stale && !context?.isStreaming ? stale(markdown, cwd) : NONE,
  };
}
