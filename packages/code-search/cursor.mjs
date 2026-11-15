// cursor.mjs — continuation cursors for code_search paging.
//
// A cursor is an opaque base64url JSON token: where the next page starts
// (round + index), a binding to the search that issued it (workspace, query,
// filter options) and an identity of the matched content. Paging re-runs the
// same bounded search on every call, so a cursor never holds results; it only
// has to prove the search and the files it matched are still the same ones.

import { createHash } from "node:crypto";

const CURSOR_VERSION = 1;
const MAX_ROUND = 100_000;
const HASH_LENGTH = 16;

const sha1 = (text) => createHash("sha1").update(text).digest("hex").slice(0, HASH_LENGTH);

/**
 * Binds a cursor to the search that issued it. Page size (maxResults) is left
 * out on purpose: the cursor is a position, and a caller may change page size.
 */
export function bindingOf({ root, query, opts }) {
  return sha1(
    JSON.stringify([
      root ?? "",
      query,
      opts.path ?? "",
      opts.caseSensitive === true,
      opts.wholeWord === true,
      opts.regex === true,
    ]),
  );
}

/**
 * Identity of what the search matched: every matched file's size and mtime
 * plus a digest of its match positions and scores. Independent of whether git
 * grep or the scan path produced the matches.
 */
export function contentIdentity(files) {
  const lines = files
    .map((f) => `${f.rel}|${f.entry?.size}|${f.entry?.mtimeMs}|${f.digest}`)
    .sort();
  return sha1(lines.join("\n"));
}

export function encodeCursor({ round, index, binding, identity }) {
  const payload = { v: CURSOR_VERSION, r: round, i: index, b: binding, c: identity };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

/** Decode a cursor; throws "invalid cursor" for anything this module did not issue. */
export function decodeCursor(text) {
  let payload;
  try {
    payload = JSON.parse(Buffer.from(String(text), "base64url").toString("utf8"));
  } catch {
    throw invalid();
  }
  const ok =
    payload?.v === CURSOR_VERSION &&
    Number.isInteger(payload.r) &&
    payload.r >= 0 &&
    payload.r <= MAX_ROUND &&
    Number.isInteger(payload.i) &&
    payload.i >= 0 &&
    typeof payload.b === "string" &&
    typeof payload.c === "string";
  if (!ok) throw invalid();
  return { round: payload.r, index: payload.i, binding: payload.b, identity: payload.c };
}

function invalid() {
  return new Error("code_search: invalid cursor — rerun the search without a cursor.");
}
