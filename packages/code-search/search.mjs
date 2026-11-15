// search.mjs — code_search engine: content search over the cache inventory
// with definition-first ranking, enclosing-symbol framing, and did-you-mean
// suggestions. Two execution paths:
//   - git-grep fast path: when the session was built via git, dispatch to
//     `git grep` (injected exec) instead of reading every file — the
//     resulting hits are scored/ranked/framed through the same pipeline as
//     the scan path, so output is identical either way.
//   - scan path (fallback / non-git repos): readFile is injected, content is
//     re-read per query. The cache supplies the skip-list (binary/huge
//     files) and the symbol tables for framing.
//
// Pure-ish: readFile/exec are injected. Ranking per match:
//   definition hit (+100) > word-boundary exact match (+50) >
//   substring (+10) > comment-only line (0)
//
// Paging: each file contributes its matches best-first (score, then line),
// PER_FILE_CAP at a time. Round 0 is the first page every search returns; round 1 holds each
// file's next PER_FILE_CAP matches, and so on. A page is a slice of one round
// (ranked by score, file, line), and `nextCursor` points at the next slice, so
// later files and later matches in the same file are all reachable. Every
// call re-runs the same bounded search; the cursor carries only a position,
// the search it belongs to and the identity of the matched content.

import { createHash } from "node:crypto";
import { escapeRegExp } from "./gitignore.mjs";
import { bindingOf, contentIdentity, decodeCursor, encodeCursor } from "./cursor.mjs";

// Extensions we never scan as text (binary images, archives, compiled, …).
const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".ico",
  ".avif",
  ".svgz",
  ".pdf",
  ".zip",
  ".gz",
  ".tgz",
  ".tar",
  ".bz2",
  ".xz",
  ".7z",
  ".rar",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp3",
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".wav",
  ".ogg",
  ".flac",
  ".so",
  ".dylib",
  ".dll",
  ".exe",
  ".class",
  ".jar",
  ".wasm",
  ".a",
  ".o",
  ".obj",
  ".pyc",
  ".pyo",
  ".node",
  ".db",
  ".sqlite",
  ".sqlite3",
  ".lockb",
]);

const MAX_FILE_BYTES = 1024 * 1024; // >1MB files are skipped by search
const PER_FILE_CAP = 5;
const DEFAULT_MAX_RESULTS = 30;
const MAX_RESULTS_LIMIT = 100;
const MAX_SCAN_FILES = 20_000; // bound work on pathological repos

function isBinaryFile(relPath) {
  const dot = relPath.lastIndexOf(".");
  if (dot <= 0) return false;
  return BINARY_EXTENSIONS.has(relPath.slice(dot).toLowerCase());
}

/** Classic Levenshtein distance (used for did-you-mean). */
export function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 });
  let curr = Array.from({ length: n + 1 });
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

function buildMatcher(query, { caseSensitive, wholeWord, regex }) {
  if (regex) {
    return new RegExp(query, caseSensitive ? "" : "i");
  }
  let body = escapeRegExp(query);
  if (wholeWord) body = `\\b${body}\\b`;
  return new RegExp(body, caseSensitive ? "" : "i");
}

/**
 * @param {object} opts
 * @param {object} opts.cache       cache object (files: relPath → entry)
 * @param {string} opts.query
 * @param {object} opts.opts        { caseSensitive, wholeWord, regex, maxResults, path, cursor }
 * @param {(rel: string) => Promise<string | null>} opts.readFile
 * @param {(cmd: string, args: string[], execOpts?: object) => Promise<{code:number,stdout:string,stderr:string}>} [opts.exec]
 *        Injected process runner, used only for the git-grep fast path.
 * @param {string} [opts.root]      repo root, required for the git-grep fast path
 * @param {boolean} [opts.viaGit]   whether the session/inventory was built via git
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ hits: Array, total: number, start: number, remaining: number, truncated: boolean, nextCursor: string | null, suggestion: string[] }>}
 */
export async function searchRepo({
  cache,
  query,
  opts = {},
  readFile,
  exec,
  root,
  viaGit,
  signal,
}) {
  if (opts.regex) {
    const unsafe = checkRegexSafety(query);
    if (unsafe) throw new Error(`code_search regex rejected: ${unsafe}`);
  }

  // Decode and bind-check before any work, so a foreign cursor costs nothing.
  const cursor = opts.cursor ? decodeCursor(opts.cursor) : null;
  const binding = bindingOf({ root, query, opts });
  if (cursor && cursor.binding !== binding) {
    throw new Error(
      "code_search: cursor is for a different search (workspace, query or options changed) — rerun without a cursor.",
    );
  }
  const paging = { cursor, binding };

  if (viaGit && exec && root) {
    try {
      const result = await gitGrepSearch({ cache, query, opts, exec, root, signal, paging });
      if (result) return result;
    } catch (error) {
      // Cancellation and a stale cursor are answers; only git trouble falls back.
      if (error?.paging || signal?.aborted) throw error;
    }
  }

  return scanRepo({ cache, query, opts, readFile, signal, paging });
}

async function scanRepo({ cache, query, opts, readFile, signal, paging }) {
  const files = Object.keys(cache?.files ?? {});
  const matcher = buildMatcher(query, opts);
  const keep = keepFor(paging.cursor);
  const perFile = [];
  let scanned = 0;

  for (const rel of files) {
    if (signal?.aborted) throw new Error("code_search: search cancelled");
    if (opts.path && !(rel === opts.path || rel.startsWith(opts.path + "/"))) continue;
    const entry = cache.files[rel];
    if (isBinaryFile(rel)) continue;
    if ((entry?.size ?? 0) > MAX_FILE_BYTES) continue;
    if (++scanned > MAX_SCAN_FILES) break;

    const source = await readFile(rel);
    if (source == null) continue;
    const lines = source.split(/\r?\n/);
    const matches = [];
    for (let idx = 0; idx < lines.length; idx++) {
      const raw = lines[idx];
      matcher.lastIndex = 0;
      const m = matcher.exec(raw);
      if (!m) continue;
      matches.push({ lineNo: idx + 1, col: (m.index ?? 0) + 1, text: raw });
    }
    if (matches.length > 0) perFile.push(collectFile({ rel, entry, matches, query, opts, keep }));
  }

  const page = rankPage({ perFile, opts, paging });
  const suggestion = page.total === 0 ? suggestNames(query, files, cache) : [];
  return { ...page, suggestion, scanned };
}

// --- git-grep fast path -----------------------------------------------------

/**
 * Parse one `git grep -n --column` output line into { rel, lineNo, col, text }.
 * Only the first three colon-separated fields (file, line, col) are split;
 * everything after is kept verbatim as `text` (which may itself contain
 * colons).
 */
export function parseGitGrepLine(line) {
  const m = /^(.*?):(\d+):(\d+):([\s\S]*)$/.exec(line);
  if (!m) return null;
  return { rel: m[1], lineNo: Number(m[2]), col: Number(m[3]), text: m[4] };
}

/** Build the `git grep` argv for a given query/opts. Exported for tests. */
export function buildGitGrepArgs({ query, opts, root }) {
  const args = ["-C", root, "grep", "-I", "-n", "--column", "--untracked"];
  if (!opts.caseSensitive) args.push("-i");
  if (opts.regex) args.push("-E");
  else args.push("--fixed-strings");
  if (opts.wholeWord) args.push("-w");
  args.push("-e", query);
  if (opts.path) args.push("--", opts.path);
  return args;
}

/**
 * Fast path for git-backed repos: run `git grep` instead of reading every
 * file, then reuse the same scoring/ranking/framing pipeline as the scan
 * path. Returns null (signalling "fall back to scan") on any error or
 * unexpected exit code; a nonzero exit with empty stdout (code 1) means "no
 * matches", which is not an error.
 */
async function gitGrepSearch({ cache, query, opts, exec, root, signal, paging }) {
  if (signal?.aborted) throw new Error("code_search: search cancelled");
  const args = buildGitGrepArgs({ query, opts, root });
  const result = await exec("git", args, { timeout: 15_000 });
  const stdout = String(result?.stdout ?? "");

  // Exit code 1 with empty stdout means "no matches", which is not an error.
  const noMatches = result?.code === 1 && stdout.trim() === "";
  if (!noMatches && result?.code !== 0) return null; // unexpected exit code → fall back

  if (signal?.aborted) throw new Error("code_search: search cancelled");

  const byFile = new Map();
  for (const line of noMatches ? [] : stdout.split("\n")) {
    if (!line) continue;
    const parsed = parseGitGrepLine(line);
    if (!parsed) continue;
    const { rel, lineNo, col, text } = parsed;
    const entry = cache?.files?.[rel];
    if (!entry) continue; // not in the inventory (e.g. cache is stale)
    if (isBinaryFile(rel)) continue;
    if ((entry.size ?? 0) > MAX_FILE_BYTES) continue;
    if (!byFile.has(rel)) byFile.set(rel, { entry, matches: [] });
    byFile.get(rel).matches.push({ lineNo, col, text });
  }

  const keep = keepFor(paging.cursor);
  const perFile = [...byFile].map(([rel, { entry, matches }]) =>
    collectFile({ rel, entry, matches, query, opts, keep }),
  );
  const page = rankPage({ perFile, opts, paging });
  const suggestion =
    page.total === 0 ? suggestNames(query, Object.keys(cache?.files ?? {}), cache) : [];
  return { ...page, suggestion };
}

// --- ranking and paging -------------------------------------------------------

/** A cursor problem the caller must see, never a reason to retry another path. */
function pagingError(message) {
  return Object.assign(new Error(message), { paging: true });
}

/** How many matches per file the requested round needs to have kept. */
function keepFor(cursor) {
  return ((cursor?.round ?? 0) + 1) * PER_FILE_CAP;
}

/**
 * One file's working set: every match is scored and digested (for the cursor's
 * content identity) and ranked best-first (score, then line) before anything is
 * cut, so a definition late in a file is never lost behind earlier comments.
 * Only the first `keep` ranked matches are kept.
 */
function collectFile({ rel, entry, matches, query, opts, keep }) {
  const digest = createHash("sha1");
  // Identical lines all contain the query, so each one is a match: counting the
  // matches counts the repeats, on the scan and the git-grep path alike.
  const repeats = new Map();
  for (const m of matches) repeats.set(m.text, (repeats.get(m.text) ?? 0) + 1);
  const ranked = matches.map((m) => {
    const score = scoreLine(m.text, m.lineNo, query, entry, opts);
    digest.update(`${m.lineNo}:${score}\n`);
    return { rel, ...m, score, entry, dupes: repeats.get(m.text) };
  });
  ranked.sort((a, b) => b.score - a.score || a.lineNo - b.lineNo);
  return {
    rel,
    entry,
    count: ranked.length,
    kept: ranked.slice(0, keep),
    digest: digest.digest("hex"),
  };
}

const byRank = (a, b) => b.score - a.score || a.rel.localeCompare(b.rel) || a.lineNo - b.lineNo;

/**
 * Pick the requested page. Round r is every file's matches ranked r*cap … r*cap+cap-1
 * within the file; within a round hits rank by score, file, line. Round 0 is the
 * same compact first page the search always returned.
 */
function rankPage({ perFile, opts, paging }) {
  const { cursor, binding } = paging;
  const maxResults = clampMax(opts.maxResults);
  const total = perFile.reduce((n, f) => n + f.count, 0);
  const identity = contentIdentity(perFile);
  if (cursor && cursor.identity !== identity) throw staleCursor();

  const roundSize = (r) =>
    perFile.reduce(
      (n, f) => n + Math.min(PER_FILE_CAP, Math.max(0, f.count - r * PER_FILE_CAP)),
      0,
    );
  const lastRound = Math.max(0, ...perFile.map((f) => Math.ceil(f.count / PER_FILE_CAP) - 1));
  const round = cursor?.round ?? 0;
  const index = cursor?.index ?? 0;
  if (round > lastRound || index > roundSize(round)) throw staleCursor();

  const inRound = perFile
    .flatMap((f) => f.kept.slice(round * PER_FILE_CAP, (round + 1) * PER_FILE_CAP))
    .sort(byRank);
  const hits = inRound.slice(index, index + maxResults);

  let start = index;
  for (let r = 0; r < round; r++) start += roundSize(r);
  const end = index + hits.length;
  let next = null;
  if (end < inRound.length) next = { round, index: end };
  else if (round < lastRound) next = { round: round + 1, index: 0 };

  const remaining = total - start - hits.length;
  return {
    hits,
    total,
    start,
    remaining,
    truncated: remaining > 0,
    nextCursor: next ? encodeCursor({ ...next, binding, identity }) : null,
  };
}

function staleCursor() {
  return pagingError(
    "code_search: cursor is stale — the matching files changed since it was issued; rerun the search without a cursor.",
  );
}

// --- regex safety guard ------------------------------------------------------

/**
 * Heuristic (not a proof) catastrophic-backtracking check: flags a group
 * `(...)` that contains its own quantifier (+, *, or {n,}) and is itself
 * immediately followed by a quantifier — the classic `(a+)+` / `(a*)*` /
 * `(a{2,})+` shape. This will not catch every ReDoS pattern and may flag a
 * few safe ones; it exists to reject the obvious cases cheaply before
 * compiling/running a user-supplied regex.
 */
export function checkRegexSafety(pattern) {
  const re = /\(([^()]*)\)\s*(?:[+*]|\{\d*,\d*\})/g;
  let m;
  while ((m = re.exec(String(pattern ?? "")))) {
    const inner = m[1] ?? "";
    if (/[+*]|\{\d*,\d*\}/.test(inner)) {
      return "pattern looks like it could cause catastrophic backtracking (nested quantifiers) — simplify it or set regex=false.";
    }
  }
  return null;
}

function clampMax(maxResults) {
  const n = Number(maxResults);
  if (!Number.isFinite(n)) return DEFAULT_MAX_RESULTS;
  return Math.min(MAX_RESULTS_LIMIT, Math.max(1, Math.trunc(n)));
}

function scoreLine(raw, lineNo, query, entry, opts) {
  const trimmed = raw.trim();
  // Comment-only line → 0 (approx: line starts with a comment marker).
  if (/^(#|\/\/|\/\*|\*|<!--|--|%|;)/.test(trimmed)) return 0;
  // Word-boundary exact match of the query → +50, else a plain substring → +10.
  const boundaryRe = new RegExp(`\\b${escapeRegExp(query)}\\b`, opts.caseSensitive ? "" : "i");
  const base = boundaryRe.test(raw) ? 50 : 10;
  // Definition at this line (symbol name equals query, case-insensitive) → 100
  const isDef = (entry?.symbols ?? []).some(
    (s) => s.startLine === lineNo && s.name.toLowerCase() === String(query).toLowerCase(),
  );
  return isDef ? 100 : base;
}

/**
 * Innermost enclosing symbol for a line, per file entry.
 * Returns { kind, name, signature, startLine, endLine } or null.
 */
export function enclosingSymbol(entry, lineNo) {
  const symbols = entry?.symbols ?? [];
  let best = null;
  for (const s of symbols) {
    if (s.startLine > lineNo) continue;
    if (s.endLine >= 0 && s.endLine < lineNo) continue;
    if (
      !best ||
      s.startLine > best.startLine ||
      (s.startLine === best.startLine && (s.endLine < 0 || s.endLine > best.endLine))
    ) {
      best = s;
    }
  }
  return best;
}

function suggestNames(query, files, cache) {
  const seen = new Set();
  const q = String(query ?? "").toLowerCase();
  if (!q) return [];
  for (const rel of files) {
    for (const s of cache.files[rel]?.symbols ?? []) {
      const name = s.name?.toLowerCase();
      if (!name || seen.has(name)) continue;
      if (levenshtein(q, name) <= 2 && name !== q) seen.add(name);
    }
  }
  return [...seen].sort((a, b) => levenshtein(q, a) - levenshtein(q, b)).slice(0, 3);
}
