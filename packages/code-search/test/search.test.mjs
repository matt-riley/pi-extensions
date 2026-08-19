import { test } from "node:test";
import assert from "node:assert/strict";
import { enclosingSymbol, levenshtein, searchRepo } from "../search.mjs";

// Minimal cache shape: relPath → entry { size, lang, symbols, ... }
function entry(symbols, size = 100) {
  return { size, lang: "ts", symbols, imports: [], reexports: [] };
}
const sym = (name, startLine, endLine = startLine, kind = "function") =>
  ({ name, kind, startLine, endLine, signature: "" });

const FILES = {
  "src/a.ts": entry([
    sym("greet", 1, 10),
    sym("inner", 4, 6),
  ]),
  "src/b.ts": entry([sym("greet", 2, 20), sym("other", 8, 9)]),
  "src/c.ts": entry([sym("greeter", 1, 30)]),
  "notes.txt": entry([], 50),
};

const readFile = async (rel) => {
  const content = {
    "src/a.ts": `export function greet() {\n  // comment line\n  const x = 1;\n  function inner() {\n    return 'greet here';\n  }\n  return x;\n}\nconst later = 1;`,
    "src/b.ts": `function greet(a: string) {\n  return a;\n}\n// greet in comment\nconst unused = 1;`,
    "src/c.ts": `export const greeter = {\n  name: 'greet',\n};\nconst z = 1;`,
    "notes.txt": "greet is mentioned in notes",
  };
  return content[rel] ?? null;
};

test("searchRepo finds substring matches with case-insensitivity", async () => {
  const r = await searchRepo({ cache: { files: FILES }, query: "GREET", opts: {}, readFile });
  assert.equal(r.total, 7); // a:1,5 · b:1,4 · c:1,2 · notes:1
  assert.ok(r.hits.every((h) => h.text.toLowerCase().includes("greet")));
});

test("definitions rank first", async () => {
  const r = await searchRepo({ cache: { files: FILES }, query: "greet", opts: { wholeWord: true }, readFile });
  assert.ok(r.hits.length >= 2);
  const top = r.hits[0];
  assert.equal(top.rel, "src/a.ts");
  assert.equal(top.lineNo, 1); // the definition line, not the comment or call
  assert.equal(top.score, 100);
});

test("comment-only lines score zero and sort last", async () => {
  const r = await searchRepo({ cache: { files: FILES }, query: "greet", opts: { wholeWord: true }, readFile });
  const commentHit = r.hits.find((h) => h.text.includes("comment"));
  assert.ok(commentHit);
  assert.equal(commentHit.score, 0);
  // All scored hits sort above the comment hit
  for (const h of r.hits) {
    if (h === commentHit) break;
    assert.ok(h.score >= commentHit.score);
  }
});

test("path scoping narrows results", async () => {
  const r = await searchRepo({ cache: { files: FILES }, query: "greet", opts: { path: "src" }, readFile });
  assert.equal(r.total, 6);
  assert.ok(r.hits.every((h) => h.rel.startsWith("src/")));
  const single = await searchRepo({ cache: { files: FILES }, query: "greet", opts: { path: "src/b.ts" }, readFile });
  assert.equal(single.total, 2);
  assert.ok(single.hits.every((h) => h.rel === "src/b.ts"));
});

test("regex option supports patterns", async () => {
  const r = await searchRepo({ cache: { files: FILES }, query: "gr(eet|eeter)", opts: { regex: true }, readFile });
  assert.equal(r.total, 7);
});

test("invalid regex is reported as a thrown error", async () => {
  await assert.rejects(
    searchRepo({ cache: { files: FILES }, query: "(", opts: { regex: true }, readFile }),
    /Unterminated group/i,
  );
});

test("caseSensitive excludes wrong-case matches and still suggests", async () => {
  const r = await searchRepo({ cache: { files: FILES }, query: "GREET", opts: { caseSensitive: true }, readFile });
  assert.equal(r.total, 0);
  assert.deepEqual(r.suggestion, ["greeter"]);
});

test("wholeWord avoids prefix matches", async () => {
  const r = await searchRepo({ cache: { files: FILES }, query: "greet", opts: { wholeWord: true }, readFile });
  // "greeter" is a different word — c.ts's line 1 is not a whole-word match
  assert.equal(r.total, 6);
});

test("binary and oversized files are skipped", async () => {
  const files = {
    ...FILES,
    "img.png": entry([], 10),
    "huge.log": entry([], 1024 * 1024 + 1),
  };
  const r = await searchRepo({ cache: { files }, query: "greet", opts: {}, readFile });
  assert.ok(!r.hits.some((h) => h.rel === "img.png" || h.rel === "huge.log"));
});

test("per-file cap and global truncation note", async () => {
  const files = {
    "big.ts": entry(
      Array.from({ length: 40 }, (_, i) => sym(`f${i}`, i + 1, i + 1)),
      1000,
    ),
  };
  const content = Array.from({ length: 40 }, (_, i) => `function f${i}() { greet(); }`).join("\n");
  const r = await searchRepo({
    cache: { files },
    query: "greet",
    opts: { maxResults: 10 },
    readFile: async () => content,
  });
  assert.equal(r.hits.length, 5); // per-file cap
  assert.equal(r.total, 40);
  assert.equal(r.truncated, true);
});

test("did-you-mean suggests near symbol names on zero hits", async () => {
  const files = { "src/a.ts": entry([sym("greeter", 1, 1), sym("greets", 2, 2), sym("green", 3, 3)]) };
  const r = await searchRepo({ cache: { files }, query: "greet", opts: { caseSensitive: true }, readFile: async () => "x" });
  assert.equal(r.total, 0);
  assert.deepEqual(r.suggestion, ["greets", "green", "greeter"]);
});

test("enclosingSymbol picks the innermost enclosing symbol", () => {
  const e = entry([sym("outer", 1, 10), sym("mid", 3, 8), sym("inner", 5, 6)]);
  assert.equal(enclosingSymbol(e, 4)?.name, "mid");
  assert.equal(enclosingSymbol(e, 5)?.name, "inner");
  assert.equal(enclosingSymbol(e, 9)?.name, "outer");
  assert.equal(enclosingSymbol(e, 11), null);
  // open-ended ranges (fallback langs) still frame from their start line
  const open = entry([sym("pyfn", 3, -1)]);
  assert.equal(enclosingSymbol(open, 7)?.name, "pyfn");
  assert.equal(enclosingSymbol(open, 2), null);
});

test("levenshtein distances", () => {
  assert.equal(levenshtein("greet", "greet"), 0);
  assert.equal(levenshtein("greet", "greets"), 1);
  assert.equal(levenshtein("kitten", "sitting"), 3);
  assert.equal(levenshtein("", "abc"), 3);
});
