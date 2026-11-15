import { test } from "node:test";
import assert from "node:assert/strict";

import { formatReport, runArchitectureCheck } from "../check.mjs";

const RULES = JSON.stringify({
  ignore: ["**/test/**"],
  rules: [
    {
      name: "packages-are-islands",
      from: "packages/*/**",
      forbid: ["packages/**"],
      except: ["packages/$1/**"],
      reason: "share code through shared/",
    },
    { name: "shared-is-a-leaf", from: "shared/**", forbid: ["packages/**"] },
  ],
});

const run = (tree, rulesText = RULES, extra = {}) =>
  runArchitectureCheck({
    files: Object.keys(tree),
    readFile: async (rel) => tree[rel] ?? null,
    rulesText,
    ...extra,
  });

const CLEAN = {
  "packages/a/index.ts": 'import { h } from "./helper";\nimport { s } from "../../shared/s.mjs";',
  "packages/a/helper.ts": "export const h = 1;",
  "shared/s.mjs": "export const s = 1;",
};

test("a repository inside its boundaries has no findings and complete coverage", async () => {
  const report = await run(CLEAN);
  assert.equal(report.ok, true);
  assert.deepEqual(report.violations, []);
  assert.deepEqual(report.cycles, []);
  assert.equal(report.coverage.complete, true);
  assert.equal(report.coverage.sourceFiles, 3);
  assert.equal(report.coverage.edges, 2);
  assert.equal(report.rules.count, 2);
});

test("a forbidden import names the rule, both files, the line and the reason", async () => {
  const report = await run({
    ...CLEAN,
    "packages/b/index.ts": 'import "./ok";\nimport { h } from "../a/helper";',
    "packages/b/ok.ts": "",
    "shared/leak.mjs": 'import { h } from "../packages/a/helper";',
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.violations, [
    {
      rule: "packages-are-islands",
      from: "packages/b/index.ts",
      to: "packages/a/helper.ts",
      line: 2,
      kind: "static",
      reason: "share code through shared/",
    },
    {
      rule: "shared-is-a-leaf",
      from: "shared/leak.mjs",
      to: "packages/a/helper.ts",
      line: 1,
      kind: "static",
      reason: null,
    },
  ]);
});

test("files matched by ignore are not checked", async () => {
  const report = await run({
    ...CLEAN,
    "packages/b/test/x.test.mjs": 'import { h } from "../../a/helper";',
  });
  assert.deepEqual(report.violations, []);
});

test("a dynamic import inside an ignored file is not a coverage gap", async () => {
  const report = await run({
    ...CLEAN,
    "packages/a/test/x.test.mjs": 'await import("../helper");',
  });
  assert.equal(report.coverage.complete, true);
  assert.equal(report.coverage.edges, 2);
});

test("a forbidden type-only import is still a violation, and says it is type-only", async () => {
  const report = await run({
    ...CLEAN,
    "packages/b/index.ts": 'import type { H } from "../a/helper";',
  });
  assert.equal(report.violations[0].kind, "type");
});

test("import cycles are reported as closed paths, and can be switched off", async () => {
  const tree = {
    "src/a.ts": 'import "./b";',
    "src/b.ts": 'import "./c";',
    "src/c.ts": 'import "./a";',
  };
  const on = await run(tree, JSON.stringify({ rules: [] }));
  assert.deepEqual(on.cycles, [["src/a.ts", "src/b.ts", "src/c.ts", "src/a.ts"]]);
  assert.equal(on.ok, false);
  const off = await run(tree, JSON.stringify({ rules: [], cycles: "off" }));
  assert.equal(off.cycles, null);
  assert.equal(off.ok, true);
});

test("with no rules file the cycle check still runs and the report says so", async () => {
  const report = await run(CLEAN, null);
  assert.equal(report.rules.present, false);
  assert.equal(report.rules.count, 0);
  assert.deepEqual(report.cycles, []);
  assert.match(formatReport(report), /no rules file/i);
});

test("a broken rules file is an error, not a pass", async () => {
  const report = await run(CLEAN, '{"rules":[{"name":"x","from":"a/**"}]}');
  assert.equal(report.ok, false);
  assert.match(report.rules.errors.join("\n"), /forbid/);
  assert.match(formatReport(report), /rules\[0\]/);
});

test("dynamic imports, unresolved aliases and the inventory cap make coverage incomplete", async () => {
  const tree = {
    "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["src/*"] } } }),
    "src/a.ts": 'const m = await import("./b");\nimport("./pages/" + n);\nimport "@/missing";',
    "src/b.ts": "",
  };
  const report = await run(tree, JSON.stringify({ rules: [] }), { inventoryCapped: true });
  assert.equal(report.coverage.complete, false);
  assert.deepEqual(
    report.coverage.incomplete.map((entry) => entry.kind),
    ["dynamic-import", "dynamic-import", "unresolved", "inventory-cap"],
  );
  // The literal import("./b") is still an edge, so rules see it.
  assert.equal(report.coverage.edges, 1);
  const text = formatReport(report);
  assert.match(text, /INCOMPLETE/);
  assert.doesNotMatch(text, /no findings/i);
});

test("a file-count cap is reported through the same list", async () => {
  const tree = { "a.ts": "", "b.ts": "", "c.ts": "" };
  const report = await run(tree, JSON.stringify({ rules: [] }), { limits: { maxFiles: 2 } });
  assert.equal(report.coverage.complete, false);
  assert.equal(report.coverage.incomplete.at(-1).kind, "file-cap");
  assert.equal(report.coverage.sourceFiles, 3);
  assert.equal(report.coverage.scanned, 2);
});

test("only TypeScript and JavaScript are read; other files are listed, not parsed", async () => {
  const report = await run({
    "src/a.ts": 'import data from "./data.json";',
    "src/data.json": "{}",
    "docs/readme.md": "# hi",
    "styles/site.css": "",
  });
  assert.equal(report.coverage.sourceFiles, 1);
  assert.equal(report.coverage.otherFiles, 3);
  assert.equal(report.coverage.edges, 1);
});

test("the report does not depend on the order the files arrive in", async () => {
  const forward = await run({ ...CLEAN, "packages/b/index.ts": 'import "../a/helper";' });
  const tree = { ...CLEAN, "packages/b/index.ts": 'import "../a/helper";' };
  const backward = await runArchitectureCheck({
    files: Object.keys(tree).toReversed(),
    readFile: async (rel) => tree[rel] ?? null,
    rulesText: RULES,
  });
  assert.deepEqual(backward, forward);
});

test("long listings are cut with a count of what was left out", async () => {
  const tree = {};
  for (let i = 0; i < 60; i += 1) tree[`shared/f${i}.mjs`] = 'import "../packages/a/x";';
  tree["packages/a/x.ts"] = "";
  const report = await run(tree);
  assert.equal(report.violations.length, 60);
  const text = formatReport(report);
  assert.match(text, /60 violations/);
  assert.match(text, /and 35 more/);
  assert.ok(text.split("\n").length < 60);
});
