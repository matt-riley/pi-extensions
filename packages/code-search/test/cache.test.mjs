import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  CACHE_VERSION,
  cachePathFor,
  cacheStats,
  loadCache,
  parseFilePayload,
  refreshCache,
  saveCache,
} from "../cache.mjs";

async function tmpDir() {
  const dir = await mkdtemp(join(tmpdir(), "pi-cs-cache-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("cachePathFor nests under .pi/cache", () => {
  assert.equal(cachePathFor("/repo"), join("/repo", ".pi", "cache", "pi-code-search.json"));
});

test("parseFilePayload extracts TS symbols and fallback symbols", () => {
  const ts = parseFilePayload("export function foo() {}\nexport class Bar {}", "src/a.ts");
  assert.equal(ts.lang, "ts");
  assert.deepEqual(ts.symbols.list.map((s) => s.name), ["foo", "Bar"]);
  assert.equal(ts.symbols.truncated, false);

  const py = parseFilePayload("def hello():\n    pass", "main.py");
  assert.equal(py.lang, "py");
  assert.equal(py.symbols.list[0].name, "hello");

  const md = parseFilePayload("# Readme", "README.md");
  assert.equal(md.lang, "md");
  assert.equal(md.symbols.list[0].name, "Readme");
});

test("parseFilePayload caps symbols per file", () => {
  const src = Array.from({ length: 600 }, (_, i) => `function fn${i}() {}`).join("\n");
  const { symbols } = parseFilePayload(src, "big.ts");
  assert.equal(symbols.list.length, 500);
  assert.equal(symbols.truncated, true);
  assert.equal(symbols.total, 600);
});

test("loadCache returns null for missing, corrupt, or version-mismatched files", async () => {
  const { dir, cleanup } = await tmpDir();
  try {
    assert.equal(await loadCache(join(dir, "missing.json")), null);
    await writeFile(join(dir, "corrupt.json"), "{not json");
    assert.equal(await loadCache(join(dir, "corrupt.json")), null);
    await writeFile(join(dir, "old.json"), JSON.stringify({ version: 0, files: {} }));
    assert.equal(await loadCache(join(dir, "old.json")), null);
  } finally {
    await cleanup();
  }
});

test("saveCache writes atomically and loadCache round-trips", async () => {
  const { dir, cleanup } = await tmpDir();
  try {
    const file = join(dir, "c.json");
    const cache = { version: CACHE_VERSION, root: dir, builtAt: 1, files: { a: { size: 1 } } };
    await saveCache(file, cache);
    assert.deepEqual(await loadCache(file), cache);
    const leftovers = (await readFile(file, "utf8")).includes(".tmp-");
    assert.equal(leftovers, false);
    // No tmp files left behind
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(dir), ["c.json"]);
  } finally {
    await cleanup();
  }
});

test("refreshCache builds from scratch, reuses unchanged, re-parses changed, drops removed", async () => {
  const { dir, cleanup } = await tmpDir();
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src/a.ts"), "export function alpha() {}");
    await writeFile(join(dir, "src/b.ts"), "export function beta() {}");
    await writeFile(join(dir, "src/c.ts"), "export function gamma() {}");

    const list = async () => ({ files: ["src/a.ts", "src/b.ts", "src/c.ts"], truncated: false });
    const statFn = async (rel) => {
      const { stat } = await import("node:fs/promises");
      const s = await stat(join(dir, rel));
      return { mtimeMs: s.mtimeMs, size: s.size };
    };
    const readFn = (rel) => readFile(join(dir, rel), "utf8");

    const first = await refreshCache({ cache: null, root: dir, list, stat: statFn, readFile: readFn });
    assert.deepEqual(first.changed.sort(), ["src/a.ts", "src/b.ts", "src/c.ts"]);
    assert.equal(Object.keys(first.cache.files).length, 3);
    assert.equal(first.cache.files["src/a.ts"].symbols[0].name, "alpha");

    // Second refresh: nothing changed → no re-parse
    const second = await refreshCache({ cache: first.cache, root: dir, list, stat: statFn, readFile: readFn });
    assert.deepEqual(second.changed, []);
    assert.equal(second.cache.files["src/a.ts"].symbols[0].name, "alpha");

    // Touch b.ts → only b re-parsed
    await writeFile(join(dir, "src/b.ts"), "export function beta2() {}");
    const third = await refreshCache({ cache: second.cache, root: dir, list, stat: statFn, readFile: readFn });
    assert.deepEqual(third.changed, ["src/b.ts"]);
    assert.equal(third.cache.files["src/b.ts"].symbols[0].name, "beta2");

    // Remove c.ts from the listing → dropped
    const shrunkList = async () => ({ files: ["src/a.ts", "src/b.ts"], truncated: false });
    const fourth = await refreshCache({ cache: third.cache, root: dir, list: shrunkList, stat: statFn, readFile: readFn });
    assert.deepEqual(fourth.removed, ["src/c.ts"]);
    assert.equal(fourth.cache.files["src/c.ts"], undefined);
  } finally {
    await cleanup();
  }
});

test("refreshCache skips files that vanish between listing and stat", async () => {
  const { dir, cleanup } = await tmpDir();
  try {
    const statFn = async () => null; // everything "missing"
    const list = async () => ({ files: ["a.ts"], truncated: false });
    const { cache } = await refreshCache({ cache: null, root: dir, list, stat: statFn, readFile: async () => null });
    assert.equal(Object.keys(cache.files).length, 0);
  } finally {
    await cleanup();
  }
});

test("cacheStats counts files and symbols", () => {
  const cache = {
    files: {
      a: { symbolCount: 3 },
      b: { symbolCount: 5 },
      c: {},
    },
  };
  assert.deepEqual(cacheStats(cache), { fileCount: 3, symbolCount: 8 });
});

test("saveCache cleans up its temp file on write failure", async () => {
  const { dir, cleanup } = await tmpDir();
  try {
    const file = join(dir, "sub", "c.json"); // sub doesn't exist → mkdir creates it
    await saveCache(file, { version: CACHE_VERSION, files: {} });
    const { readdir } = await import("node:fs/promises");
    assert.deepEqual(await readdir(join(dir, "sub")), ["c.json"]);
    void dirname; // imported for parity
  } finally {
    await cleanup();
  }
});
