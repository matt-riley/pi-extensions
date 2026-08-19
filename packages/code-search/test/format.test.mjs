import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTreeLines,
  findKeyFiles,
  findTestFiles,
  fmtBytes,
  formatDefinitions,
  formatOutline,
  formatRepoMap,
  formatSearchHits,
  frameHit,
  languageBreakdown,
  packageHighlights,
} from "../format.mjs";

test("fmtBytes", () => {
  assert.equal(fmtBytes(512), "512 B");
  assert.equal(fmtBytes(2048), "2.0 KiB");
  assert.equal(fmtBytes(5 * 1024 * 1024), "5.0 MiB");
});

test("languageBreakdown counts by extension", () => {
  const counts = languageBreakdown(["a.ts", "b.ts", "c.py", "README"]);
  assert.deepEqual(counts, [["ts", 2], ["py", 1], ["?", 1]]);
});

test("buildTreeLines renders dirs collapsed and files", () => {
  const files = ["src/a.ts", "src/sub/b.ts", "package.json", "README.md"];
  const lines = buildTreeLines(files, 2);
  assert.ok(lines.some((l) => l === "src/"));
  assert.ok(lines.some((l) => l.includes("a.ts")));
  assert.ok(lines.some((l) => l.includes("package.json")));
  // deep collapse at the frontier
  const many = Array.from({ length: 30 }, (_, i) => `src/f${i}.ts`);
  const collapsed = buildTreeLines(many, 1);
  assert.ok(collapsed.some((l) => l.includes("(30 files)")));
});

test("findKeyFiles and findTestFiles", () => {
  const files = ["README.md", "package.json", "tsconfig.json", "src/a.test.ts", "test/x.ts", "src/b.ts"];
  assert.ok(findKeyFiles(files).includes("README.md"));
  assert.ok(findKeyFiles(files).includes("package.json"));
  assert.ok(findTestFiles(files).includes("src/a.test.ts"));
  assert.ok(findTestFiles(files).includes("test/x.ts"));
  assert.ok(!findTestFiles(files).includes("src/b.ts"));
});

test("packageHighlights extracts name, scripts, entry, deps", () => {
  const lines = packageHighlights("package.json", {
    name: "demo",
    version: "1.0.0",
    scripts: { build: "tsc", test: "vitest" },
    main: "dist/index.js",
    dependencies: { a: "1" },
    devDependencies: { b: "2", c: "3" },
  });
  assert.ok(lines.some((l) => l.includes("demo")));
  assert.ok(lines.some((l) => l.includes("scripts (2)")));
  assert.ok(lines.some((l) => l.includes("dist/index.js")));
  assert.ok(lines.some((l) => l.includes("1 runtime, 2 dev")));
  assert.equal(packageHighlights("package.json", null), null);
});

test("formatRepoMap includes sections and caps lines", () => {
  const text = formatRepoMap({
    root: "/repo",
    branch: "main",
    viaGit: true,
    files: [{ rel: "a.ts", size: 10 }, { rel: "b.ts", size: 20 }],
    truncated: false,
    languages: [["ts", 2]],
    tree: ["src/", "  a.ts"],
    keyFiles: ["README.md"],
    testFiles: ["a.test.ts"],
    pkg: ["name: demo"],
    newest: [{ rel: "b.ts", size: 20 }],
    largest: [{ rel: "a.ts", size: 10 }],
    symbolCount: 42,
  });
  assert.ok(text.includes("# Repo map"));
  assert.ok(text.includes("42"));
  assert.ok(text.includes("## Tree"));
  assert.ok(text.includes("## Key files"));
  // cap: feed a huge tree
  const capped = formatRepoMap({
    root: "/r", branch: "", viaGit: false, files: [], truncated: false,
    languages: [], tree: Array.from({ length: 500 }, (_, i) => `f${i}`),
    keyFiles: [], testFiles: [], pkg: null, newest: [], largest: [], symbolCount: 0,
  });
  assert.ok(capped.includes("truncated at 150 lines"));
});

test("formatOutline sorts by line and strips redundant kind/name prefixes", () => {
  const text = formatOutline({
    relPath: "src/a.ts",
    symbols: [
      { name: "bar", kind: "function", signature: "function bar(x: number)", startLine: 10 },
      { name: "foo", kind: "interface", signature: "interface foo", startLine: 2 },
    ],
    truncated: false,
  });
  assert.ok(text.indexOf("L2") < text.indexOf("L10"));
  assert.ok(text.includes("interface foo") && !text.includes("interface foo interface foo"));
  assert.ok(text.includes("function bar"));
});

test("formatOutline notes truncation", () => {
  const symbols = Array.from({ length: 210 }, (_, i) => ({ name: `f${i}`, kind: "function", signature: "", startLine: i + 1 }));
  const text = formatOutline({ relPath: "a.ts", symbols, truncated: true });
  assert.ok(text.includes("more symbols"));
});

test("formatSearchHits frames hits and reports truncation", () => {
  const hit = {
    rel: "src/a.ts",
    lineNo: 3,
    col: 5,
    text: "  const x = greet();",
    entry: { symbols: [{ name: "run", kind: "function", signature: "run()", startLine: 1, endLine: 9 }] },
  };
  const text = formatSearchHits({
    query: "greet",
    hits: [hit],
    total: 25,
    truncated: true,
    suggestion: [],
  });
  assert.ok(text.includes("src/a.ts:3:5"));
  assert.ok(text.includes("in function run"));
  assert.ok(text.includes("and 24 more matches"));
});

test("frameHit returns null without a symbol table", () => {
  assert.equal(frameHit({ entry: { symbols: [] } }), null);
});

test("formatDefinitions lists candidates with context and external notes", () => {
  const text = formatDefinitions({
    symbol: "foo",
    external: null,
    candidates: [
      { rel: "src/foo.ts", line: 4, kind: "function", name: "foo", signature: "foo(a: string)", exported: true, context: ["export function foo(a: string) {"] },
      { rel: "src/bar.ts", line: 9, kind: "class", name: "foo", signature: "", exported: false, context: [] },
      { rel: "src/baz.ts", line: 2, kind: "type", name: "foo", signature: "", exported: false, context: [] },
      { rel: "src/qux.ts", line: 1, kind: "function", name: "foo", signature: "", exported: false, context: [] },
    ],
    note: null,
  });
  assert.ok(text.includes("src/foo.ts:4"));
  assert.ok(text.includes("(exported)"));
  assert.ok(text.includes("and 1 more candidates"));

  const ext = formatDefinitions({ symbol: "react", external: "react", candidates: [], note: null });
  assert.ok(ext.includes("external: react"));
  assert.ok(ext.includes("not indexed"));
});
