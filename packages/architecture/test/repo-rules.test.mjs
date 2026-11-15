import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { listRepoFiles } from "../../code-search/inventory.mjs";
import { runArchitectureCheck } from "../check.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const read = (rel) => readFile(join(ROOT, rel), "utf8").catch(() => null);

// The walker, not git, so the test needs no repository state.
const { files } = await listRepoFiles({ root: ROOT });
const rulesText = await read(".pi/architecture.json");

const check = (extra = {}) =>
  runArchitectureCheck({
    files: [...files, ...Object.keys(extra)],
    readFile: async (rel) => extra[rel] ?? read(rel),
    rulesText,
  });

test("this repository passes its own .pi/architecture.json", async () => {
  const report = await check();
  assert.deepEqual(report.rules.errors, []);
  assert.equal(report.rules.count, 3);
  assert.deepEqual(report.violations, []);
  assert.deepEqual(report.cycles, []);
  assert.ok(report.coverage.edges > 100, "the import graph was actually read");
  // Dynamic imports are the only thing allowed to be unfollowed.
  assert.deepEqual(
    report.coverage.incomplete.filter((entry) => entry.kind !== "dynamic-import"),
    [],
  );
});

test("shared/ importing a package is caught", async () => {
  const report = await check({
    "shared/bad.mjs": 'import "../packages/guardrail/index.ts";',
  });
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.violations.map((v) => [v.rule, v.from]),
    [["shared-is-a-leaf", "shared/bad.mjs"]],
  );
});

test("a package importing another package's internals is caught", async () => {
  const report = await check({
    "packages/doctor/bad.mjs": 'import "../router/index.ts";',
  });
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.violations.map((v) => [v.rule, v.from, v.to]),
    [["packages-are-islands", "packages/doctor/bad.mjs", "packages/router/index.ts"]],
  );
});

test("a package importing from scripts/ is caught", async () => {
  const report = await check({
    "packages/doctor/bad.mjs": 'import "../../scripts/registration.mjs";',
  });
  assert.deepEqual(
    report.violations.map((v) => v.rule),
    ["packages-do-not-use-scripts"],
  );
});

test("a new import cycle is caught", async () => {
  const report = await check({
    "shared/cycle-a.mjs": 'import "./cycle-b.mjs";',
    "shared/cycle-b.mjs": 'import "./cycle-a.mjs";',
  });
  assert.equal(report.ok, false);
  assert.equal(report.cycles.length, 1);
});
