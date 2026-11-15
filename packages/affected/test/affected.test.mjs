import { test } from "node:test";
import assert from "node:assert/strict";

import { formatAffected, isTestFile, selectAffected } from "../affected.mjs";

const select = (tree, changed, extra = {}) =>
  selectAffected({
    files: Object.keys(tree),
    readFile: async (rel) => tree[rel] ?? null,
    changed,
    ...extra,
  });

const REPO = {
  "package.json": JSON.stringify({ name: "root", scripts: { test: "node --test src/*.test.mjs" } }),
  "src/a.mjs": 'import { b } from "./b.mjs";',
  "src/b.mjs": 'import { c } from "./c.mjs";',
  "src/c.mjs": "export const c = 1;",
  "src/d.mjs": "export const d = 1;",
  "src/a.test.mjs": 'import "./a.mjs";',
  "src/d.test.mjs": 'import "./d.mjs";',
  "src/c.test.mjs": 'import "./c.mjs";',
};

test("test files are recognised by name or by a __tests__ directory, JS and TS only", () => {
  for (const yes of ["a.test.ts", "x/b.spec.mjs", "x/__tests__/c.js", "src/d.test.tsx"]) {
    assert.equal(isTestFile(yes), true, yes);
  }
  for (const no of [
    "test/helpers.mjs",
    "src/a.mjs",
    "a.test.json",
    "x/__tests__/d.md",
    "testing.ts",
  ]) {
    assert.equal(isTestFile(no), false, no);
  }
});

test("a change selects every test that reaches it, directly or through imports", async () => {
  const report = await select(REPO, ["src/c.mjs"]);
  assert.equal(report.mode, "selected");
  assert.deepEqual(report.tests, ["src/a.test.mjs", "src/c.test.mjs"]);
  assert.equal(report.complete, true);
  assert.deepEqual(report.gaps, { unreached: [], nonJs: [], deleted: [], graph: [] });
});

test("a changed test file selects itself", async () => {
  const report = await select(REPO, ["src/d.test.mjs"]);
  assert.deepEqual(report.tests, ["src/d.test.mjs"]);
  assert.equal(report.complete, true);
});

test("a changed source file no test reaches is a gap, and the rest is still selected", async () => {
  const tree = { ...REPO, "src/orphan.mjs": "export {};" };
  const report = await select(tree, ["src/d.mjs", "src/orphan.mjs"]);
  assert.equal(report.mode, "selected");
  assert.deepEqual(report.tests, ["src/d.test.mjs"]);
  assert.deepEqual(report.gaps.unreached, ["src/orphan.mjs"]);
  assert.equal(report.complete, false);
});

test("a changed non-JS file nothing imports is a gap; one a test imports is selected", async () => {
  const tree = {
    ...REPO,
    "src/data.json": "{}",
    "src/e.test.mjs": 'import data from "./data.json" with { type: "json" };',
    "docs/guide.md": "# hi",
    "styles/site.css": "",
  };
  const report = await select(tree, ["src/data.json", "docs/guide.md", "styles/site.css"]);
  assert.deepEqual(report.tests, ["src/e.test.mjs"]);
  assert.deepEqual(report.gaps.nonJs, ["docs/guide.md", "styles/site.css"]);
});

test("a deleted file is a gap, and its importers' unresolved import forces the fallback", async () => {
  const tree = { ...REPO };
  delete tree["src/c.mjs"];
  const report = await select(tree, ["src/c.mjs"]);
  assert.deepEqual(report.gaps.deleted, ["src/c.mjs"]);
  assert.equal(report.mode, "fallback");
});

test("a computed import() in code a test reaches makes the graph incomplete: fall back", async () => {
  const tree = { ...REPO, "src/b.mjs": 'import("./x/" + name);\nimport "./c.mjs";' };
  const report = await select(tree, ["src/d.mjs"]);
  assert.equal(report.mode, "fallback");
  assert.equal(report.complete, false);
  assert.deepEqual(
    report.gaps.graph.map(({ kind, file, line }) => [kind, file, line]),
    [["dynamic-import", "src/b.mjs", 1]],
  );
  assert.match(report.fallback.reasons.join("\n"), /src\/b\.mjs:1/);
  assert.deepEqual(report.fallback.commands, [{ dir: "", command: "npm test" }]);
  // What it did find is still reported, as a floor rather than the answer.
  assert.deepEqual(report.tests, ["src/d.test.mjs"]);
});

test("a computed import() nothing a test reaches can load does not change the answer", async () => {
  const tree = { ...REPO, "scripts/run.mjs": "await import(process.argv[2]);" };
  const report = await select(tree, ["src/c.mjs"]);
  assert.equal(report.mode, "selected");
  assert.equal(report.complete, true);
  assert.equal(report.ignoredGaps, 1);
});

test("a literal import() that resolves is followed and is not a gap", async () => {
  const tree = { ...REPO, "src/a.mjs": 'const m = await import("./b.mjs");' };
  const report = await select(tree, ["src/c.mjs"]);
  assert.equal(report.mode, "selected");
  assert.deepEqual(report.tests, ["src/a.test.mjs", "src/c.test.mjs"]);
});

test("a literal import() that names no file is a gap", async () => {
  const tree = { ...REPO, "src/a.mjs": 'await import("./nope.mjs");' };
  assert.equal((await select(tree, ["src/c.mjs"])).mode, "fallback");
});

test("an inventory or file cap forces the fallback", async () => {
  assert.equal((await select(REPO, ["src/c.mjs"], { inventoryCapped: true })).mode, "fallback");
  assert.equal((await select(REPO, ["src/c.mjs"], { limits: { maxFiles: 3 } })).mode, "fallback");
});

test("no changed files is its own answer, and too many changed files falls back", async () => {
  assert.equal((await select(REPO, [])).mode, "nothing");
  const many = Array.from({ length: 501 }, (_, i) => `src/f${i}.mjs`);
  const report = await select(REPO, many);
  assert.equal(report.mode, "fallback");
  assert.match(report.fallback.reasons.join(), /501 changed files/);
});

test("the fallback names the package-level command from the nearest package.json with a test script", async () => {
  const tree = {
    "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
    "packages/a/package.json": JSON.stringify({ name: "a", scripts: { test: "vitest run" } }),
    "packages/a/src/x.ts": "import(name);",
    "packages/a/src/x.test.ts": 'import "./x";',
    "packages/b/package.json": JSON.stringify({ name: "b" }),
    "packages/b/y.ts": "",
  };
  const report = await select(tree, ["packages/a/src/x.ts", "packages/b/y.ts"]);
  assert.equal(report.mode, "fallback");
  assert.deepEqual(report.fallback.commands, [
    { dir: "packages/a", command: "npm test --workspace packages/a" },
    { dir: "packages/b", command: null },
  ]);
});

test("a run hint is given only for a runner it can recognise", async () => {
  const node = await select(REPO, ["src/c.mjs"]);
  assert.equal(node.runHint, "node --test src/a.test.mjs src/c.test.mjs");
  const vitest = await select(
    { ...REPO, "package.json": JSON.stringify({ scripts: { test: "vitest run" } }) },
    ["src/c.mjs"],
  );
  assert.equal(vitest.runHint, "npx vitest run src/a.test.mjs src/c.test.mjs");
  const other = await select(
    { ...REPO, "package.json": JSON.stringify({ scripts: { test: "ava" } }) },
    ["src/c.mjs"],
  );
  assert.equal(other.runHint, null);
});

test("the report is the same whatever order files and changes arrive in", async () => {
  const forward = await select(REPO, ["src/c.mjs", "src/d.mjs"]);
  const backward = await selectAffected({
    files: Object.keys(REPO).toReversed(),
    readFile: async (rel) => REPO[rel] ?? null,
    changed: ["src/d.mjs", "src/c.mjs"],
  });
  assert.deepEqual(backward, forward);
});

test("nothing is run or written: the text says so and lists the selection", async () => {
  const text = formatAffected(await select(REPO, ["src/c.mjs"]));
  assert.match(text, /2 test files/);
  assert.match(text, /src\/a\.test\.mjs/);
  assert.match(text, /Nothing was run/);
  assert.match(text, /node --test src\/a\.test\.mjs src\/c\.test\.mjs/);
});

test("the fallback text leads with the command and calls the selection a floor", async () => {
  const tree = { ...REPO, "src/b.mjs": 'import("./x/" + name);\nimport "./c.mjs";' };
  const text = formatAffected(await select(tree, ["src/c.mjs"]));
  assert.match(text, /incomplete/i);
  assert.match(text, /Run npm test instead/);
  assert.match(text, /at least/);
});

test("gaps are listed under their own headings", async () => {
  const tree = { ...REPO, "src/orphan.mjs": "", "notes.md": "" };
  const text = formatAffected(await select(tree, ["src/c.mjs", "src/orphan.mjs", "notes.md"]));
  assert.match(text, /No test reaches[^\n]*\n\s+src\/orphan\.mjs/);
  assert.match(text, /Not TypeScript or JavaScript[^\n]*\n\s+notes\.md/);
});
