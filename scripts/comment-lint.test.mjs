import assert from "node:assert/strict";
import { test } from "node:test";
import { lintComments } from "./comment-lint.mjs";

test("reports exact narration of an AST statement with source locations", () => {
  const findings = lintComments(
    "sample.ts",
    "// increment counter\ncounter++;\n// return result\nreturn result;\n",
  );
  assert.equal(findings.length, 2);
  assert.deepEqual(
    findings.map((x) => [x.rule, x.line]),
    [
      ["no-needless-comment", 1],
      ["no-needless-comment", 3],
    ],
  );
});

test("preserves documentation, rationale, directives and uncertain prose", () => {
  for (const source of [
    "/** Returns the cached result without another network request. */\nfunction result() { return cached; }",
    "/** return result */\nreturn result;",
    "// Increment counter because zero is reserved.\ncounter++;",
    "// return result only after validating it\nreturn result;",
    "// return result\n// Keep identity: callers compare references.\nreturn result;",
    "// eslint-disable-next-line no-plusplus\ncounter++;",
    "// Copyright Example\ncounter++;",
    'const url = "https://example.com//return result";',
    "const text = `\n// increment counter\ncounter++;\n`;",
    "const re = /\\/\\/ increment counter/;",
    "const a = <div>// increment counter</div>;",
    "previous(); // increment counter\ncounter++;",
    "// increment other\ncounter++;",
  ])
    assert.deepEqual(lintComments("sample.tsx", source), [], source);
});

test("handles prefix, postfix, call and ordinary block-comment narration", () => {
  for (const source of [
    "// increment the counter.\n++counter;",
    "// decrement counter\n--counter;",
    "// decrement the counter\ncounter--;",
    "/* call refresh */\nrefresh();",
  ])
    assert.equal(lintComments("sample.mjs", source).length, 1, source);
  for (const source of [
    "// increment counter\n+counter;",
    "// call refresh only when stale\nrefresh();",
    "// increment counter\ncache.counter++;",
    "// return result\nfunction result() { return cached; }",
  ])
    assert.deepEqual(lintComments("sample.ts", source), [], source);
});

test("does not pretend to parse Go documentation as JavaScript", () => {
  assert.deepEqual(
    lintComments(
      "sample.go",
      "// Result returns the cached result.\nfunc Result() int { return 1 }",
    ),
    [],
  );
});
