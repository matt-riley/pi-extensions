import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatRunReport, runChecks } from "../run-checks.mjs";

function scratch(t) {
  const cwd = mkdtempSync(join(tmpdir(), "done-gate-run-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

test("a passing command reports its output and exit code", async (t) => {
  const [r] = await runChecks({ commands: ["echo hello"], cwd: scratch(t) });
  assert.equal(r.status, "passed");
  assert.equal(r.code, 0);
  assert.match(r.output, /hello/);
});

test("a failing command is reported as failed with its exit code and stderr", async (t) => {
  const [r] = await runChecks({ commands: ["echo oops >&2; exit 3"], cwd: scratch(t) });
  assert.equal(r.status, "failed");
  assert.equal(r.code, 3);
  assert.match(r.output, /oops/);
});

test("commands run one after another, in order, inside cwd", async (t) => {
  const cwd = scratch(t);
  const results = await runChecks({ commands: ["pwd", "echo second"], cwd });
  assert.deepEqual(
    results.map((r) => r.command),
    ["pwd", "echo second"],
  );
  assert.match(results[0].output, /done-gate-run-/);
});

test("a command past its timeout is killed and reported, not waited for", async (t) => {
  const started = Date.now();
  const [r] = await runChecks({
    commands: ["echo before; sleep 30"],
    cwd: scratch(t),
    timeoutMs: 200,
  });
  assert.equal(r.status, "timed out");
  assert.match(r.output, /before/);
  assert.ok(Date.now() - started < 5000, "did not wait for the sleep");
});

test("a timeout kills the whole process group, not just the shell", async (t) => {
  const cwd = scratch(t);
  const marker = join(cwd, "late");
  await runChecks({
    commands: [`(sleep 1; touch ${marker}) & wait`],
    cwd,
    timeoutMs: 200,
  });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(existsSync(marker), false);
});

test("output is capped to the tail and says it was cut", async (t) => {
  const [r] = await runChecks({
    commands: ["yes xxxxxxxxxx | head -n 20000; echo THE-END"],
    cwd: scratch(t),
    maxOutput: 200,
  });
  assert.equal(r.truncated, true);
  assert.ok(r.output.length <= 200);
  assert.match(r.output, /THE-END/);
});

test("an abort signal cancels a running command", async (t) => {
  const controller = new AbortController();
  const started = Date.now();
  const pending = runChecks({
    commands: ["sleep 30", "echo never"],
    cwd: scratch(t),
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 150);
  const results = await pending;
  assert.equal(results[0].status, "cancelled");
  assert.equal(results.length, 1, "later commands never start");
  assert.ok(Date.now() - started < 5000);
});

test("an already aborted signal runs nothing", async (t) => {
  const cwd = scratch(t);
  const results = await runChecks({
    commands: [`touch ${join(cwd, "ran")}`],
    cwd,
    signal: AbortSignal.abort(),
  });
  assert.deepEqual(results, []);
  assert.equal(existsSync(join(cwd, "ran")), false);
});

test("at most maxCommands run; the rest are counted as skipped in the report", async (t) => {
  const commands = ["echo 1", "echo 2", "echo 3"];
  const results = await runChecks({ commands, cwd: scratch(t), maxCommands: 2 });
  assert.equal(results.length, 2);
  const report = formatRunReport(results, commands.length - results.length);
  assert.match(report, /1 more command\(s\) not run/);
});

test(".pi/verify is run as ./.pi/verify", async (t) => {
  const cwd = scratch(t);
  const [r] = await runChecks({ commands: [".pi/verify"], cwd });
  assert.equal(r.command, ".pi/verify");
  assert.equal(r.status, "failed"); // not present in this scratch dir
  assert.match(r.output, /\.pi\/verify/);
});

test("formatRunReport lists each command with status and output", () => {
  const report = formatRunReport([
    {
      command: "go test ./a",
      status: "passed",
      code: 0,
      durationMs: 1200,
      output: "ok\n",
      truncated: false,
    },
    {
      command: "tsc --noEmit -p x",
      status: "failed",
      code: 2,
      durationMs: 50,
      output: "err\n",
      truncated: true,
    },
  ]);
  assert.match(report, /PI_DONE_GATE_EXEC/);
  assert.match(report, /`go test \.\/a` — passed \(exit 0, 1\.2s\)/);
  assert.match(report, /`tsc --noEmit -p x` — failed \(exit 2, 0\.1s\)/);
  assert.match(report, /earlier output cut/);
  assert.match(report, /does not count as a verification run/);
});
