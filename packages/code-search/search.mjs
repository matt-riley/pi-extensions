// search.mjs — code_search engine: content search over the cache inventory
// with definition-first ranking, enclosing-symbol framing, and did-you-mean
// suggestions. Content is re-read per query (scan-based); the cache supplies
// the skip-list (binary/huge files) and the symbol tables for framing.
//
// Pure-ish: readFile is injected. Ranking per match:
//   definition hit (+100) > whole-word exact (+50) > word-boundary (+30) >
//   substring (+10) > comment-only line (0)

import { escapeRegExp } from "./gitignore.mjs";

// Extensions we never scan as text (binary images, archives, compiled, …).
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".avif", ".svgz",
  ".pdf", ".zip", ".gz", ".tgz", ".tar", ".bz2", ".xz", ".7z", ".rar",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".mov", ".avi", ".mkv", ".wav", ".ogg", ".flac",
  ".so", ".dylib", ".dll", ".exe", ".class", ".jar", ".wasm", ".a", ".o",
  ".obj", ".pyc", ".pyo", ".node", ".db", ".sqlite", ".sqlite3", ".lockb",
]);

export const MAX_FILE_BYTES = 1024 * 1024; // >1MB files are skipped by search
export const PER_FILE_CAP = 5;
export const DEFAULT_MAX_RESULTS = 30;
export const MAX_RESULTS_LIMIT = 100;
const MAX_SCAN_FILES = 20_000; // bound work on pathological repos

export function isBinaryFile(relPath) {
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
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
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
 * @param {object} opts.opts        { caseSensitive, wholeWord, regex, maxResults, path }
 * @param {(rel: string) => Promise<string | null>} opts.readFile
 * @returns {Promise<{ hits: Array, total: number, truncated: boolean, suggestion: string[] }>}
 */
export async function searchRepo({ cache, query, opts = {}, readFile }) {
  const files = Object.keys(cache?.files ?? {});
  const maxResults = clampMax(opts.maxResults);
  const matcher = buildMatcher(query, opts);
  const hits = [];
  let total = 0;
  let scanned = 0;

  for (const rel of files) {
    if (opts.path && !(rel === opts.path || rel.startsWith(opts.path + "/"))) continue;
    const entry = cache.files[rel];
    if (isBinaryFile(rel)) continue;
    if ((entry?.size ?? 0) > MAX_FILE_BYTES) continue;
    if (++scanned > MAX_SCAN_FILES) break;

    const source = await readFile(rel);
    if (source == null) continue;
    const lines = source.split(/\r?\n/);
    const fileHits = [];
    for (let idx = 0; idx < lines.length; idx++) {
      const lineNo = idx + 1;
      const raw = lines[idx];
      matcher.lastIndex = 0;
      const m = matcher.exec(raw);
      if (!m) continue;
      const col = (m.index ?? 0) + 1;
      total++;
      const score = scoreLine(raw, lineNo, query, entry, opts);
      if (fileHits.length < PER_FILE_CAP) fileHits.push({ rel, lineNo, col, score, text: raw, entry });
    }
    fileHits.sort((a, b) => b.score - a.score || a.lineNo - b.lineNo);
    hits.push(...fileHits);
  }

  hits.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel) || a.lineNo - b.lineNo);
  const shown = hits.slice(0, maxResults);
  const truncated = total > shown.length;

  let suggestion = [];
  if (total === 0) suggestion = suggestNames(query, files, cache);

  return { hits: shown, total, truncated, suggestion, scanned };
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
  let base = 10; // substring
  if (opts.wholeWord) {
    base = 30;
    // Whole-word exact match of the query → +50
    const re = new RegExp(`\\b${escapeRegExp(query)}\\b`, opts.caseSensitive ? "" : "i");
    if (re.test(raw)) base = 50;
  }
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
    if (!best || s.startLine > best.startLine || (s.startLine === best.startLine && (s.endLine < 0 || s.endLine > best.endLine))) {
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
