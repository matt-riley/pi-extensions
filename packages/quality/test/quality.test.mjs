import assert from "node:assert/strict";
import { test } from "node:test";
import { formatQuality, runQuality } from "../quality.mjs";

const clean = (tool) =>
  tool === "crap"
    ? { v: 1, ok: true, summary: { files: 1, functions: 1 }, coverage: null, findings: [] }
    : { v: 1, ok: true, complete: true, summary: { files: 1 }, findings: [] };

function setup(overrides = {}, files = "src/main.ts\0") {
  const calls = [];
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    if (cmd === "git")
      return { code: 0, stdout: args.includes("rev-parse") ? "/repo with spaces\n" : files };
    if (overrides[cmd]) return overrides[cmd]();
    return { code: 0, stdout: JSON.stringify(clean(cmd)), stderr: "" };
  };
  return { exec, calls };
}

test("runs both actual CLI interfaces at the git root, with no fixes", async () => {
  const h = setup();
  const report = await runQuality({ cwd: "/repo with spaces/src", exec: h.exec });
  assert.equal(report.ok, true);
  assert.deepEqual(
    report.checks.map((x) => [x.tool, x.status]),
    [
      ["crap", "passed"],
      ["deadwood", "passed"],
    ],
  );
  const checks = h.calls.filter((x) => x.cmd !== "git");
  assert.equal(checks.length, 2);
  assert.deepEqual(
    checks.map((x) => x.args),
    [
      [".", "--format", "json", "--fail-above"],
      [".", "--format", "json", "--fail-on", "high"],
    ],
  );
  for (const call of checks) {
    assert.equal(call.opts.cwd, "/repo with spaces");
    assert.ok(call.opts.timeout > 0);
    assert.ok(call.opts.maxBuffer > 0);
  }
});

for (const tool of ["crap", "deadwood"]) {
  test(`still runs the sibling check when ${tool} is missing`, async () => {
    const h = setup({
      [tool]: () => {
        throw new Error("ENOENT: binary not installed");
      },
    });
    const report = await runQuality({ cwd: "/repo", exec: h.exec });
    assert.equal(report.ok, false);
    assert.equal(report.checks.length, 2);
    assert.equal(report.checks.find((x) => x.tool === tool).status, "error");
    assert.match(formatQuality(report), /ENOENT: binary not installed/);
    assert.equal(report.checks.find((x) => x.tool !== tool).status, "passed");
  });
}

for (const result of [
  { code: 1, stdout: JSON.stringify({ ...clean("deadwood"), ok: false }) },
  { code: 2, stdout: JSON.stringify({ ...clean("deadwood"), complete: false }) },
  { code: 0, stdout: JSON.stringify({ ...clean("deadwood"), complete: false }) },
  { code: 0, stdout: "not JSON" },
  { code: 0, stdout: "{}" },
  { code: 0, stdout: JSON.stringify({ ...clean("deadwood"), summary: { files: 0 } }) },
  { code: 0, stdout: JSON.stringify(clean("deadwood")), killed: true },
  { code: 0, stdout: JSON.stringify(clean("deadwood")), truncated: true },
]) {
  test(`does not pass failed, incomplete or invalid output: ${JSON.stringify(result)}`, async () => {
    const h = setup({ deadwood: () => result });
    const report = await runQuality({ cwd: "/repo", exec: h.exec });
    assert.equal(report.ok, false);
    assert.equal(report.checks[1].status, result.code === 1 ? "findings" : "error");
    assert.equal(report.checks[0].status, "passed");
  });
}

test("source detection excludes declarations and dependency/build directories", async () => {
  for (const files of [
    "README.md\0",
    "types/api.d.ts\0",
    "vendor/pkg.go\0node_modules/pkg/index.js\0target/debug/main.rs\0",
  ]) {
    const h = setup({}, files);
    const report = await runQuality({ cwd: "/repo", exec: h.exec });
    assert.equal(report.ok, false);
    assert.equal(report.checks.length, 0);
    assert.match(report.note, /Skipped: no supported/);
    assert.equal(h.calls.length, 2);
  }
});

test("inventory errors and truncation cannot silently skip tools as if clean", async () => {
  for (const result of [{ code: 1 }, { code: 0, truncated: true }, { code: 0, killed: true }]) {
    const report = await runQuality({
      cwd: "/repo",
      exec: async (_cmd, args) =>
        args.includes("rev-parse") ? { code: 0, stdout: "/repo" } : result,
    });
    assert.equal(report.ok, false);
    assert.equal(report.checks.length, 0);
    assert.match(report.note, /inventory is incomplete/);
  }
});

test("bounds presentation and explicitly marks truncation", async () => {
  const h = setup({ crap: () => ({ code: 2, stdout: "x".repeat(20000) }) });
  const report = await runQuality({ cwd: "/repo", exec: h.exec });
  assert.equal(report.checks[0].output.length, 16000);
  assert.equal(report.checks[0].truncated, true);
  assert.match(formatQuality(report), /output truncated/);
});
