// marks.mjs — what emphasis learns from the collection before it draws a reply.
//
// Two readings, both display-only and both quiet when they cannot tell:
//   - whether the reply was written over code edits no check covered, from the
//     spans done-gate publishes (shared/evidence-state.mjs);
//   - which paths named in the reply are missing under the session's cwd, from
//     the existence check subagents already use (shared/stalepaths.mjs).
//
// pi runs a transformer on every streaming update, resize and restored message,
// so the path check is cached and skipped while a reply is still streaming.

import { uncheckedEditsAt } from "../../shared/evidence-state.mjs";
import { findStalePaths } from "../../shared/stalepaths.mjs";

const NONE = new Set();
const MAX_ENTRIES = 64;
const TTL_MS = 2000;

/**
 * A cached `findStalePaths` keyed by cwd and text. An entry is reused for
 * `ttlMs`, so a file created a moment later is noticed on the next render.
 */
export function createStaleLookup({ find = findStalePaths, now = Date.now, ttlMs = TTL_MS } = {}) {
  const cache = new Map();
  return (markdown, cwd) => {
    if (!cwd || !markdown.includes("`")) return NONE;
    const key = cwd + "\0" + markdown;
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.paths;
    const paths = new Set(find(markdown, cwd));
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
