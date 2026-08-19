import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGitGrepArgs, checkRegexSafety, enclosingSymbol, levenshtein, parseGitGrepLine, searchRepo } from "../search.mjs";

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

// --- default-mode ranking (task 2) -----------------------------------------

test("default mode ranks exact word-boundary matches above substring-in-longer-identifier matches", async () => {
  const files = { "a.ts": entry([], 50) };
  const content = "const greeting = 1;\nconst greet = 2;\n";
  const r = await searchRepo({ cache: { files }, query: "greet", opts: {}, readFile: async () => content });
  assert.equal(r.hits[0].text.trim(), "const greet = 2;");
  assert.equal(r.hits[0].score, 50);
  const substringHit = r.hits.find((h) => h.text.includes("greeting"));
  assert.ok(substringHit);
  assert.equal(substringHit.score, 10);
  assert.ok(r.hits[0].score > substringHit.score);
});

// --- git-grep fast path (task 1) -------------------------------------------

test("buildGitGrepArgs maps search options to git grep flags", () => {
  assert.deepEqual(
    buildGitGrepArgs({ query: "foo", opts: {}, root: "/r" }),
    ["-C", "/r", "grep", "-I", "-n", "--column", "--untracked", "-i", "--fixed-strings", "-e", "foo"],
  );
  assert.deepEqual(
    buildGitGrepArgs({ query: "foo", opts: { caseSensitive: true }, root: "/r" }),
    ["-C", "/r", "grep", "-I", "-n", "--column", "--untracked", "--fixed-strings", "-e", "foo"],
  );
  assert.deepEqual(
    buildGitGrepArgs({ query: "f(oo)", opts: { regex: true }, root: "/r" }),
    ["-C", "/r", "grep", "-I", "-n", "--column", "--untracked", "-i", "-E", "-e", "f(oo)"],
  );
  assert.deepEqual(
    buildGitGrepArgs({ query: "foo", opts: { wholeWord: true }, root: "/r" }),
    ["-C", "/r", "grep", "-I", "-n", "--column", "--untracked", "-i", "--fixed-strings", "-w", "-e", "foo"],
  );
  assert.deepEqual(
    buildGitGrepArgs({ query: "foo", opts: { path: "src" }, root: "/r" }),
    ["-C", "/r", "grep", "-I", "-n", "--column", "--untracked", "-i", "--fixed-strings", "-e", "foo", "--", "src"],
  );
});

test("parseGitGrepLine splits only file:line:col, keeps colons in the text field", () => {
  assert.deepEqual(
    parseGitGrepLine("src/a.ts:12:5:const x = 'a:b:c';"),
    { rel: "src/a.ts", lineNo: 12, col: 5, text: "const x = 'a:b:c';" },
  );
  assert.equal(parseGitGrepLine("not a match"), null);
});

test("git-grep fast path parses hits (incl. colons in text) and reuses the scoring/framing pipeline", async () => {
  const files = { "src/a.ts": entry([sym("greet", 1, 3)]) };
  const stdout = [
    "src/a.ts:1:1:function greet() { return 'x:y:z'; }",
    "src/a.ts:2:3:  greet(); // calls greet",
  ].join("\n") + "\n";
  const exec = async (cmd) => {
    assert.equal(cmd, "git");
    return { code: 0, stdout, stderr: "" };
  };
  const r = await searchRepo({
    cache: { files },
    query: "greet",
    opts: {},
    readFile: async () => {
      throw new Error("should not scan when git grep succeeds");
    },
    exec,
    root: "/repo",
    viaGit: true,
  });
  assert.equal(r.total, 2);
  assert.equal(r.hits[0].lineNo, 1);
  assert.equal(r.hits[0].score, 100); // definition line, framed via the same scoreLine logic
  assert.ok(r.hits.some((h) => h.text.includes("x:y:z")));
});

test("git grep exit code 1 with empty stdout means no matches, not an error", async () => {
  const files = { "a.ts": entry([]) };
  const exec = async () => ({ code: 1, stdout: "", stderr: "" });
  const r = await searchRepo({
    cache: { files },
    query: "zzz",
    opts: {},
    readFile: async () => {
      throw new Error("should not scan on a clean no-match exit");
    },
    exec,
    root: "/repo",
    viaGit: true,
  });
  assert.equal(r.total, 0);
  assert.deepEqual(r.hits, []);
});

test("git grep failure (throws) falls back silently to the scan path", async () => {
  const files = { "src/a.ts": entry([sym("greet", 1, 1)]) };
  const content = "function greet() {}\n";
  const exec = async () => {
    throw new Error("git not found");
  };
  const r = await searchRepo({
    cache: { files },
    query: "greet",
    opts: {},
    readFile: async (rel) => (rel === "src/a.ts" ? content : null),
    exec,
    root: "/repo",
    viaGit: true,
  });
  assert.equal(r.total, 1);
  assert.equal(r.hits[0].score, 100);
});

test("git grep unexpected exit code falls back silently to the scan path", async () => {
  const files = { "src/a.ts": entry([sym("greet", 1, 1)]) };
  const content = "function greet() {}\n";
  const exec = async () => ({ code: 2, stdout: "", stderr: "fatal: not a git repository" });
  const r = await searchRepo({
    cache: { files },
    query: "greet",
    opts: {},
    readFile: async (rel) => (rel === "src/a.ts" ? content : null),
    exec,
    root: "/repo",
    viaGit: true,
  });
  assert.equal(r.total, 1);
});

test("git-grep path is skipped (falls to scan) when viaGit is false", async () => {
  const files = { "src/a.ts": entry([sym("greet", 1, 1)]) };
  const content = "function greet() {}\n";
  const exec = async () => {
    throw new Error("exec should not be called when viaGit is false");
  };
  const r = await searchRepo({
    cache: { files },
    query: "greet",
    opts: {},
    readFile: async (rel) => (rel === "src/a.ts" ? content : null),
    exec,
    root: "/repo",
    viaGit: false,
  });
  assert.equal(r.total, 1);
});

// --- abort + regex guard (task 3) ------------------------------------------

test("checkRegexSafety rejects nested-quantifier patterns, allows normal regexes", () => {
  assert.ok(checkRegexSafety("(a+)+"));
  assert.ok(checkRegexSafety("(a*)*"));
  assert.ok(checkRegexSafety("(a{2,})+"));
  assert.equal(checkRegexSafety("gr(eet|eeter)"), null);
  assert.equal(checkRegexSafety("^foo.*bar$"), null);
});

test("searchRepo rejects catastrophic regex patterns with a clear message instead of running them", async () => {
  await assert.rejects(
    searchRepo({ cache: { files: FILES }, query: "(a+)+", opts: { regex: true }, readFile }),
    /catastrophic|nested quantifiers/i,
  );
});

test("searchRepo still accepts normal regexes under the guard", async () => {
  const r = await searchRepo({ cache: { files: FILES }, query: "gr(eet|eeter)", opts: { regex: true }, readFile });
  assert.equal(r.total, 7);
});

test("searchRepo throws a clear cancellation error when the signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  let readCalls = 0;
  await assert.rejects(
    searchRepo({
      cache: { files: FILES },
      query: "greet",
      opts: {},
      readFile: async (rel) => {
        readCalls++;
        return readFile(rel);
      },
      signal: controller.signal,
    }),
    /cancelled/i,
  );
  assert.equal(readCalls, 0);
});
