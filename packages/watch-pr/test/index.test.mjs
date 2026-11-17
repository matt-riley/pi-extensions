import assert from "node:assert/strict";
import test from "node:test";
import piWatchPrExtension, { sleep } from "../index.ts";

test("sleep removes its abort listener when the timer wins", async () => {
  let listeners = 0;
  const signal = {
    aborted: false,
    addEventListener: () => {
      listeners++;
    },
    removeEventListener: () => {
      listeners--;
    },
  };
  await sleep(1, signal);
  assert.equal(listeners, 0);
});

test("sleep wakes early when the signal aborts", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const pending = sleep(5000, controller.signal);
  controller.abort();
  await pending;
  assert.ok(Date.now() - started < 1000, "abort should resolve without waiting the timer");
});

test(
  "the registered watcher reports unknown once and does not poll incomplete evidence",
  { timeout: 1000 },
  async () => {
    const clean = {
      number: 7,
      url: "https://github.com/o/r/pull/7",
      state: "OPEN",
      isDraft: false,
      headRefOid: "head",
      baseRefName: "main",
      mergeStateStatus: "CLEAN",
      reviewDecision: "APPROVED",
      statusCheckRollup: [{ name: "ci", status: "COMPLETED", conclusion: "SUCCESS" }],
    };
    const graph = JSON.stringify([
      {
        data: {
          repository: {
            pullRequest: {
              headRefOid: "head",
              reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          },
        },
      },
    ]);
    for (const fixture of [
      { checks: [], graph, verdict: "unknown" },
      { checks: clean.statusCheckRollup, graph: null, verdict: "unknown" },
      { checks: [{ name: "ci", status: "QUEUED" }], graph: null, verdict: "unknown" },
      { checks: clean.statusCheckRollup, graph, verdict: "ready" },
    ]) {
      let tool;
      let calls = 0;
      piWatchPrExtension({
        registerTool: (definition) => {
          tool = definition;
        },
        exec: async (command, args) => {
          assert.equal(command, "sh");
          assert.equal(args[2], "/workspace with spaces");
          calls++;
          const stdout =
            args[3] === "pr"
              ? JSON.stringify({ ...clean, statusCheckRollup: fixture.checks })
              : fixture.graph;
          return { code: stdout === null ? 1 : 0, stdout };
        },
      });
      const result = await tool.execute(
        "call",
        { pr: "7", wait_seconds: 600 },
        undefined,
        undefined,
        {
          cwd: "/workspace with spaces",
        },
      );
      assert.equal(result.isError, undefined);
      const text = result.content[0].text;
      assert.equal(text.split("\n")[0], fixture.verdict);
      assert.equal(calls, 2, "unknown and ready return without another poll");
      if (fixture.graph === null)
        assert.equal(text.split("review threads unavailable:").length - 1, 1);
    }
  },
);
