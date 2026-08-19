// cache.mjs — persistent symbol/inventory cache at <root>/.pi/cache/pi-code-search.json.
//
// Survives restarts, invalidated by mtime+size: on refresh we re-list the
// inventory (cheap), stat each file, and re-parse only changed/new files.
// Unchanged entries are reused wholesale. Corrupt or version-mismatched cache
// files are treated as empty and rebuilt. Writes are atomic (tmp + rename).
//
// Pure-ish module: fs access via injected functions so tests can use temp
// dirs and fakes. All fs goes through node:fs/promises.

import { mkdir, readFile, rename, stat, writeFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { MAX_FILES } from "./inventory.mjs";
import { langForFile, parseFallbackSource } from "./fallback-parser.mjs";
import { isTsFile, parseTsSource } from "./ts-parser.mjs";

export const CACHE_VERSION = 1;
export const CACHE_DIR = ".pi/cache";
export const CACHE_FILE = "pi-code-search.json";
export const MAX_SYMBOLS_PER_FILE = 500;
// Hard cap on serialized cache size; beyond it, symbols of the largest files
// are dropped (inventory entries are kept, so search/repo_map still work).
export const MAX_CACHE_BYTES = 20 * 1024 * 1024;

export function cachePathFor(root) {
  return join(root, CACHE_DIR, CACHE_FILE);
}

/** Parse a file's text into a cache entry payload. */
export function parseFilePayload(source, relPath) {
  const lang = langForFile(relPath);
  if (lang === "ts") {
    const { symbols, imports, reexports } = parseTsSource(source, { filePath: relPath });
    return {
      lang,
      symbols: capSymbols(symbols),
      imports,
      reexports,
    };
  }
  const symbols = parseFallbackSource(source, { lang });
  return { lang, symbols: capSymbols(symbols), imports: [], reexports: [] };
}

function capSymbols(symbols) {
  if (symbols.length > MAX_SYMBOLS_PER_FILE) {
    return { list: symbols.slice(0, MAX_SYMBOLS_PER_FILE), truncated: true, total: symbols.length };
  }
  return { list: symbols, truncated: false, total: symbols.length };
}

/** Load the cache file; returns null on missing/corrupt/version-mismatch. */
export async function loadCache(filePath) {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed?.version !== CACHE_VERSION || typeof parsed?.files !== "object") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Atomic write: tmp file + rename over the target. Cleans up tmp on failure. */
export async function saveCache(filePath, cache) {
  await mkdir(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  try {
    await writeFile(tmp, JSON.stringify(cache), "utf8");
    await rename(tmp, filePath);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Refresh the cache against a fresh file listing.
 *
 * @param {object} opts
 * @param {object|null} opts.cache          previous cache (or null)
 * @param {string} opts.root                repo root
 * @param {() => Promise<{files: string[], truncated: boolean}>} opts.list
 * @param {(rel: string) => Promise<{mtimeMs: number, size: number} | null>} opts.stat
 * @param {(rel: string) => Promise<string | null>} opts.readFile
 * @param {(done: number, total: number) => void} [opts.onProgress]
 * @returns {Promise<{ cache: object, changed: string[], removed: string[], truncated: boolean }>}
 */
export async function refreshCache({
  cache,
  root,
  list,
  stat: statFn,
  readFile: readFileFn,
  onProgress,
  maxSymbolsPerFile = MAX_SYMBOLS_PER_FILE,
  maxCacheBytes = MAX_CACHE_BYTES,
}) {
  const { files, truncated } = await list();
  const fileSet = new Set(files);
  const previous = cache?.files ?? {};
  const nextFiles = {};

  // Reuse unchanged entries; queue changed/new for re-parse; drop removed.
  const changed = [];
  const removed = [];
  for (const rel of files) {
    const st = await statFn(rel);
    if (!st) continue; // vanished between listing and stat (e.g. staged deletion)
    const prev = previous[rel];
    if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) {
      nextFiles[rel] = prev;
    } else {
      changed.push(rel);
    }
  }
  for (const rel of Object.keys(previous)) {
    if (!fileSet.has(rel)) removed.push(rel);
  }

  // Re-parse changed/new files with bounded concurrency.
  const CONCURRENCY = 24;
  const total = changed.length;
  const changedList = [...changed];
  let done = 0;
  async function worker() {
    while (true) {
      const rel = changed.shift();
      if (rel === undefined) return;
      const st = await statFn(rel);
      if (!st) continue;
      const source = await readFileFn(rel);
      let payload;
      if (source == null) {
        payload = {
          lang: langForFile(rel),
          symbols: { list: [], truncated: false, total: 0 },
          imports: [],
          reexports: [],
        };
      } else {
        payload = parseFilePayload(source, rel);
      }
      nextFiles[rel] = {
        mtimeMs: st.mtimeMs,
        size: st.size,
        lang: payload.lang,
        symbolCount: payload.symbols.total,
        symbolsTruncated: payload.symbols.truncated,
        symbols: payload.symbols.list,
        imports: payload.imports,
        reexports: payload.reexports,
      };
      done++;
      if (onProgress && (done % 200 === 0 || done === total)) onProgress(done, total);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, Math.max(1, total)) }, () => worker()),
  );

  const next = {
    version: CACHE_VERSION,
    root,
    builtAt: Date.now(),
    files: nextFiles,
  };

  shrinkIfNeeded(next, maxCacheBytes);

  return { cache: next, changed: changedList, removed, truncated };
}

/**
 * Drop symbols/imports/reexports of the largest files until the estimated
 * serialized cache size is under `maxBytes`. Each entry's size is
 * JSON.stringify'd once (not the whole cache, per entry, per iteration —
 * that was O(n^2) on large repos); a running total is decremented by the
 * measured before/after delta as entries are stripped. One real
 * JSON.stringify(cache) verifies the estimate at the end; if the estimate
 * drifted and it's still over, a second bounded pass strips a few more.
 */
export function shrinkIfNeeded(cache, maxBytes = MAX_CACHE_BYTES) {
  const items = Object.values(cache.files).map((e) => ({ e, bytes: JSON.stringify(e).length }));
  // Rough total: sum of per-entry sizes plus a small fixed allowance for the
  // cache wrapper object (version/root/builtAt/braces/commas).
  let total = items.reduce((sum, it) => sum + it.bytes, 0) + 64;
  if (total <= maxBytes) return;

  items.sort((a, b) => b.bytes - a.bytes);

  const strip = (it) => {
    if (it.e.symbolsDropped) return 0;
    const before = it.bytes;
    it.e.symbols = [];
    it.e.imports = [];
    it.e.reexports = [];
    it.e.symbolsDropped = true;
    it.bytes = JSON.stringify(it.e).length;
    return before - it.bytes;
  };

  for (const it of items) {
    if (total <= maxBytes) break;
    total -= strip(it);
  }

  // Verify once against the real serialized size; the estimate can drift
  // (wrapper overhead, unicode escaping, etc). If still over, keep
  // stripping the next-largest remaining entries using the same delta
  // bookkeeping rather than re-stringifying the whole cache per entry.
  let actual = JSON.stringify(cache).length;
  if (actual > maxBytes) {
    for (const it of items) {
      if (actual <= maxBytes) break;
      actual -= strip(it);
    }
  }
}

export function cacheStats(cache) {
  let fileCount = 0;
  let symbolCount = 0;
  for (const e of Object.values(cache?.files ?? {})) {
    fileCount++;
    symbolCount += e.symbolCount ?? e.symbols?.length ?? 0;
  }
  return { fileCount, symbolCount };
}

// Re-export so callers only import from cache.mjs.
export { MAX_FILES };
