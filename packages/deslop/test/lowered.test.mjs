import { test } from "node:test";
import assert from "node:assert/strict";

import { findLoweredBar } from "../lowered.mjs";

/** A diff for one file. Lines start with "+" added, " " context or "-" removed. */
function diffOf(file, lines, mode = "") {
  const count = (marks) => lines.filter((line) => marks.includes(line[0])).length;
  const gone = mode === "deleted";
  return [
    `diff --git a/${file} b/${file}`,
    ...(gone ? ["deleted file mode 100644"] : []),
    `--- a/${file}`,
    `+++ ${gone ? "/dev/null" : `b/${file}`}`,
    `@@ -1,${count(" -")} +${gone ? "0,0" : `1,${count(" +")}`} @@`,
    ...lines,
    "",
  ].join("\n");
}
const added = (file, ...lines) =>
  diffOf(
    file,
    lines.map((line) => `+${line}`),
  );
/** The findings of one diff as "id/severity" pairs. */
const kinds = (diff, messages) =>
  findLoweredBar(diff, messages).map((item) => `${item.id}/${item.severity}`);

// Fixture lines are built from parts so this file does not itself carry a directive.
const SUPPRESSIONS = {
  "src/a.ts": [
    ["// @ts", "-ignore"].join(""),
    ["// @ts", "-expect-error"].join(""),
    ["/* eslint", "-disable no-console */"].join(""),
    ["const n = x as number; // eslint", "-disable-line no-undef"].join(""),
    ["/* istanbul", " ignore next */"].join(""),
    ["// c8", " ignore next 3"].join(""),
    ["// nosemgrep", ": rule-id"].join(""),
    ["const k = 'abc'; // gitleaks", ":allow"].join(""),
  ],
  "tool.py": [
    ["import os  # no", "qa: F401"].join(""),
    ["x = f()  # type", ": ignore[attr-defined]"].join(""),
    ["y = 1  # nosemgrep", ""].join(""),
    ["if x:  # pragma", ": no cover"].join(""),
  ],
  "main.go": [["_ = f() //no", "lint:errcheck"].join(""), ["_ = g() // no", "lint"].join("")],
  "lib.rs": [["#[al", "low(dead_code)]"].join(""), ["#![al", "low(unused)]"].join("")],
  ".github/workflows/ci.yml": [["      - run: ./scan.sh # gitleaks", ":allow"].join("")],
};

test("a new suppression directive is a strong flag in every language it is written in", () => {
  for (const [file, lines] of Object.entries(SUPPRESSIONS))
    for (const line of lines) {
      const found = findLoweredBar(added(file, line));
      assert.deepEqual(
        found.map((item) => [item.id, item.severity, item.sign]),
        [["suppression", "high", "lowered-bar"]],
        `${file}: ${line}`,
      );
      assert.match(found[0].excerpts[0], new RegExp(`^${file.replace(/[.]/g, "\\.")}:1: `));
    }
});

test("a reason on the same line or an adjacent comment downgrades the flag to weak", () => {
  const ts = ["// @ts", "-expect-error: upstream typings declare this as a string"].join("");
  assert.deepEqual(kinds(added("src/a.ts", ts)), ["suppression/low"]);
  const lint = ["/* eslint", "-disable-next-line no-console -- the CLI prints its result */"].join(
    "",
  );
  assert.deepEqual(kinds(added("src/a.ts", lint)), ["suppression/low"]);
  const bare = ["// eslint", "-disable-next-line no-console"].join("");
  const above = added("src/a.ts", "// the worker has no logger to hand until it boots", bare);
  assert.deepEqual(kinds(above), ["suppression/low"]);
  const below = added("src/a.ts", bare, "// stdout is the interface of this tool");
  assert.deepEqual(kinds(below), ["suppression/low"]);
  const far = added(
    "src/a.ts",
    "// the worker has no logger to hand until it boots",
    "const a = 1;",
    bare,
  );
  assert.deepEqual(kinds(far), ["suppression/high"]);
});

test("a rule name or a code after the directive is not a reason", () => {
  for (const [file, line] of [
    ["a.ts", ["// eslint", "-disable-next-line no-console, no-undef, prefer-const"].join("")],
    ["a.py", ["import os  # no", "qa: F401"].join("")],
    ["a.ts", ["// @ts", "-ignore TS2322"].join("")],
  ])
    assert.deepEqual(kinds(added(file, line)), ["suppression/high"], line);
});

test("a directive that is only text, a string or an old line is not a new suppression", () => {
  const mention = ["// we do not use @ts", "-ignore here; fix the type instead"].join("");
  assert.deepEqual(kinds(added("src/a.ts", mention)), []);
  const quoted = `const sample = "${["// @ts", "-ignore"].join("")}";`;
  assert.deepEqual(kinds(added("src/a.ts", quoted)), []);
  const prose = ["Use # no", "qa to silence a line."].join("");
  assert.deepEqual(kinds(added("docs/guide.md", prose)), []);
  const old = diffOf("src/a.ts", [`-${["// @ts", "-ignore"].join("")}`, " const kept = 1;"]);
  assert.deepEqual(kinds(old), []);
  const context = diffOf("src/a.ts", [` ${["// @ts", "-ignore"].join("")}`, "+const next = 1;"]);
  assert.deepEqual(kinds(context), []);
});

test("a clean diff produces no flags", () => {
  const clean = [
    added("src/a.ts", "export const total = (items: number[]) => items.length;"),
    added("tool.py", "def total(items):", "    return len(items)"),
    added("src/b.rs", "#[derive(Debug)]", "struct Row;"),
  ].join("\n");
  assert.deepEqual(findLoweredBar(clean), []);
  assert.deepEqual(findLoweredBar(""), []);
  assert.deepEqual(findLoweredBar(undefined), []);
});
