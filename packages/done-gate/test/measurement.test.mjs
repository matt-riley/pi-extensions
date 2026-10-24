import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../index.ts";
import { measurementDeadlineMs } from "../measurement.mjs";
const bashResult = (output, overrides = {}) => ({
  isError: false,
  result: { structuredContent: { output, exit_code: 0, truncated: false, ...overrides } },
});

function harness(t) {
  const cwd = mkdtempSync(join(tmpdir(), "measure-command-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", cwd, ...args]);
  git("init", "-q");
  writeFileSync(join(cwd, "code.js"), "fixture");
  git("add", ".");
  git(
    "-c",
    "commit.gpgsign=false",
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "-qm",
    "test: base",
  );
  const tools = {};
  extension({
    on() {},
    registerTool: (def) => {
      tools[def.name] = def;
    },
  });
  const calls = [];
  const ctx = {
    cwd,
    executeTool: async (name, input) => {
      calls.push({ name, input });
      return bashResult(JSON.stringify({ completed: 2, cached: 0 }));
    },
  };
  return {
    ctx,
    calls,
    write: (value) => writeFileSync(join(cwd, "code.js"), value),
    run: (params = {}, signal) =>
      tools.measure_command.execute(
        "measurement",
        { command: "node benchmark.mjs", expected_work: 2, runs: 3, ...params },
        signal,
        undefined,
        ctx,
      ),
  };
}

test("controlled measurement rejects empty or partly completed work, rather than reporting success", async (t) => {
  const h = harness(t);
  for (const sample of [
    { completed: 0, cached: 0 },
    { completed: 1, cached: 0 },
  ]) {
    h.ctx.executeTool = async () => bashResult(JSON.stringify(sample));
    await assert.rejects(h.run(), /completed work/);
  }
});

test("raw value trials report independent count, spread, revision and interleaved comparison", async (t) => {
  const h = harness(t);
  const values = { baseline: [2, 4, 6], candidate: [1, 2, 3] };
  const order = [];
  h.ctx.executeTool = async (name, input) => {
    assert.equal(name, "bash");
    order.push(input.command);
    return bashResult(
      JSON.stringify({ completed: 2, cached: 0, value: values[input.command].shift() }),
    );
  };
  const { structuredContent: report } = await h.run({
    command: "candidate",
    baseline_command: "baseline",
    metric: "value",
    unit: "score",
  });
  assert.deepEqual(order, [
    "baseline",
    "candidate",
    "candidate",
    "baseline",
    "baseline",
    "candidate",
  ]);
  assert.equal(report.arms.candidate.samples.length, 3);
  assert.deepEqual(report.arms.baseline.summary, { count: 3, mean: 4, min: 2, max: 6, stdev: 2 });
  assert.deepEqual(report.arms.candidate.summary, { count: 3, mean: 2, min: 1, max: 3, stdev: 1 });
  assert.equal(report.comparison.difference, -2);
  assert.equal(report.comparison.percent_change, -50);
  assert.equal(report.comparison.ranges_overlap, true);
  assert.match(report.scope, /self-reported/);
  assert.match(report.revision.fingerprint, /^[a-f0-9]{64}$/);
});

test("single-arm duration measures host calls, not a supplied timing value", async (t) => {
  const h = harness(t);
  const { structuredContent: report } = await h.run();
  assert.equal(h.calls.length, 3);
  assert.equal(report.unit, "ms");
  assert.equal(report.comparison, undefined);
  assert.equal(report.arms.candidate.summary.count, 3);
  assert.ok(report.arms.candidate.samples.every((sample) => sample.value > 0));
});

test("cache hits, unknown counts, malformed JSON and non-finite values are rejected", async (t) => {
  const h = harness(t);
  const samples = [
    ["", /JSON/],
    ["not JSON", /JSON/],
    ["null", /completed work/],
    ["[]", /completed work/],
    ['{"completed":"2","cached":0}', /completed work/],
    ['{"completed":2,"cached":1}', /Cached/],
    ['{"completed":2}', /Cached/],
    ['{"completed":2,"cached":0}', /finite/],
    ['{"completed":2,"cached":0,"value":"4"}', /finite/],
    ['{"completed":2,"cached":0,"value":1e999}', /finite/],
  ];
  for (const [text, error] of samples) {
    h.ctx.executeTool = async () => bashResult(text);
    await assert.rejects(h.run({ metric: "value", unit: "score" }), error);
  }
});

test("invalid parameters run no commands", async (t) => {
  const h = harness(t);
  for (const params of [
    { runs: 0 },
    { runs: 1 },
    { runs: 11 },
    { runs: 3.5 },
    { expected_work: 0 },
    { expected_work: "2" },
    { metric: "value" },
    { metric: "other" },
    { command: "" },
    { baseline_command: "" },
    { timeout: 0 },
    { timeout: 61 },
  ])
    await assert.rejects(h.run(params), /Supply/);
  assert.equal(h.calls.length, 0);
});

test("host failure, cancellation and a changed revision cannot yield a report", async (t) => {
  const h = harness(t);
  const output = '{"completed":2,"cached":0}';
  for (const result of [
    bashResult(output, { exit_code: 1 }),
    bashResult(output, { truncated: true }),
    { ...bashResult(output), isError: true },
    { ...bashResult(output), isError: undefined },
    { output, exit_code: 0, truncated: false },
  ]) {
    h.ctx.executeTool = async () => result;
    await assert.rejects(h.run(), /failed or was blocked/);
  }
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(h.run({}, cancelled.signal), /abort/i);
  h.ctx.executeTool = async () => {
    h.write("mutation during a timed command");
    return bashResult('{"completed":2,"cached":0}');
  };
  await assert.rejects(h.run(), /Revision changed/);
});

test("a zero baseline is not a divide-by-zero improvement claim", async (t) => {
  const h = harness(t);
  h.ctx.executeTool = async () => bashResult('{"completed":2,"cached":0,"value":0}');
  const { structuredContent: report } = await h.run({
    command: "candidate",
    baseline_command: "baseline",
    metric: "value",
    unit: "score",
  });
  assert.equal(report.comparison.percent_change, null);
  assert.equal(report.comparison.difference, 0);
});

test("no-Git workspaces have unknown identity, not a passing measurement", async (t) => {
  const h = harness(t);
  const dir = mkdtempSync(join(tmpdir(), "measure-no-git-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  h.ctx.cwd = dir;
  await assert.rejects(h.run(), /Known Git revision/);
  assert.equal(h.calls.length, 0);
});

test("cancellation during final revision validation cannot yield a report", async (t) => {
  const h = harness(t);
  const controller = new AbortController();
  let calls = 0;
  h.ctx.executeTool = async () => {
    if (++calls === 3) setImmediate(() => controller.abort());
    return bashResult('{"completed":2,"cached":0}');
  };
  await assert.rejects(h.run({}, controller.signal), /abort/i);
});

test("cancellation during execution releases the lock without reporting partial samples", async (t) => {
  const h = harness(t);
  const controller = new AbortController();
  h.ctx.executeTool = async () => {
    controller.abort();
    return bashResult('{"completed":2,"cached":0}');
  };
  await assert.rejects(h.run({}, controller.signal), /abort/i);
  h.ctx.executeTool = async () => bashResult('{"completed":2,"cached":0}');
  assert.equal((await h.run()).structuredContent.arms.candidate.samples.length, 3);
});

test("the measurement deadline covers every trial the schema allows", () => {
  // Defaults: 3 runs of two arms at 30s each. A slow-but-honest command must not
  // be aborted before its last trial.
  assert.equal(
    measurementDeadlineMs({ runs: 3, timeout: 30, baseline: "b" }),
    3 * 2 * 30_000 + 30_000,
  );
  assert.equal(
    measurementDeadlineMs({ runs: 10, timeout: 60, baseline: undefined }),
    10 * 60_000 + 30_000,
  );
  assert.ok(
    measurementDeadlineMs({ runs: 10, timeout: 60, baseline: "b" }) >
      measurementDeadlineMs({ runs: 10, timeout: 60 }),
    "a baseline arm doubles the work and the deadline",
  );
});
