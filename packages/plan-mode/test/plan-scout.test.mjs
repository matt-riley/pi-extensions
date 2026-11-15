// plan_scout: a hidden read-only child with no shell, no writers and no way to
// start more agents. What is pinned is the toolset the child gets, the brief
// it must stand on, the limit of three at once, and that a failed scout is
// reported as failed instead of as a finding.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  isWriteCapable,
  resolveChildTools,
  usesAllowlistedBash,
} from "../../subagents/discover.mjs";
import {
  MAX_SCOUTS,
  briefProblem,
  buildScoutAgent,
  createScoutSlots,
  runPlanScout,
} from "../plan-scout.mjs";

const BRIEF =
  "Find where retry limits are read in packages/client, which helpers already parse durations, " +
  "and how this repo runs its tests. Return paths with line ranges.";

test("the scout's toolset has no shell, no writers and no way to start agents", () => {
  const agent = buildScoutAgent();
  const { tools, excludeTools } = resolveChildTools(agent);
  for (const name of ["read", "grep", "find", "ls", "repo_map", "code_search", "file_outline"]) {
    assert.ok(tools.includes(name), name);
  }
  for (const name of ["bash", "terminal_start", "edit", "write", "subagent", "web_fetch"]) {
    assert.equal(tools.includes(name), false, name);
  }
  assert.ok(excludeTools.includes("subagent"));
  assert.equal(isWriteCapable(agent), false);
  assert.equal(usesAllowlistedBash(agent), true);
});

test("the scout is told what it cannot do and what to bring back", () => {
  const { systemPrompt } = buildScoutAgent();
  assert.match(systemPrompt, /no shell/i);
  assert.match(systemPrompt, /cannot edit/i);
  assert.match(systemPrompt, /only briefing|nothing else|no other/i);
  for (const heading of ["Findings", "Reuse", "Verification", "Unknowns"]) {
    assert.match(systemPrompt, new RegExp(`## ${heading}`));
  }
});

test("briefProblem accepts a brief that stands alone", () => {
  assert.equal(briefProblem(BRIEF), null);
});

test("briefProblem rejects a brief that is empty, too thin, or points at the conversation", () => {
  assert.match(briefProblem(""), /empty/i);
  assert.match(briefProblem(undefined), /empty/i);
  assert.match(briefProblem("look at the client"), /too short/i);
  assert.match(
    briefProblem("As discussed above, look at the retry code in packages/client and report back."),
    /cannot see this conversation/i,
  );
});

test("at most three scouts run at once, and a finished one frees its place", () => {
  assert.equal(MAX_SCOUTS, 3);
  const slots = createScoutSlots();
  assert.deepEqual(
    [slots.take(), slots.take(), slots.take(), slots.take()],
    [true, true, true, false],
  );
  slots.release();
  assert.equal(slots.take(), true);
  assert.equal(slots.take(), false);
});

test("releasing more than was taken never opens extra places", () => {
  const slots = createScoutSlots(1);
  slots.release();
  slots.release();
  assert.deepEqual([slots.take(), slots.take()], [true, false]);
});

function fakeChild(result) {
  const calls = [];
  const runChild = async (options) => {
    calls.push(options);
    if (result instanceof Error) throw result;
    return result;
  };
  return { calls, runChild };
}

test("runPlanScout runs the read-only scout with the brief and returns its report", async () => {
  const { calls, runChild } = fakeChild({
    status: "completed",
    text: "## Findings\n- packages/client/retry.mjs:10-40 reads the limit",
    toolUses: 6,
  });
  const signal = new AbortController().signal;
  const out = await runPlanScout({ task: BRIEF, cwd: "/repo", model: "m", signal, runChild });
  assert.equal(out.ok, true);
  assert.match(out.text, /packages\/client\/retry\.mjs:10-40/);
  assert.match(out.text, /6 tool uses/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].task, BRIEF);
  assert.equal(calls[0].cwd, "/repo");
  assert.equal(calls[0].model, "m");
  assert.equal(calls[0].signal, signal);
  assert.equal(calls[0].agent.name, "plan-scout");
  assert.ok(calls[0].maxTurns > 0 && calls[0].timeoutMs > 0);
});

test("runPlanScout never starts a child for a bad brief", async () => {
  const { calls, runChild } = fakeChild({ status: "completed", text: "x" });
  const out = await runPlanScout({ task: "look around", cwd: "/repo", runChild });
  assert.equal(out.ok, false);
  assert.match(out.text, /^Rejected: /);
  assert.equal(calls.length, 0);
});

test("a scout that did not finish is reported as unfinished, with what it had", async () => {
  const { runChild } = fakeChild({ status: "timed out", text: "partial notes", toolUses: 2 });
  const out = await runPlanScout({ task: BRIEF, cwd: "/repo", runChild });
  assert.equal(out.ok, false);
  assert.match(out.text, /did not finish \(timed out, 2 tool uses\)/);
  assert.match(out.text, /partial notes/);
});

test("a scout that throws is a failed scout, not an exception", async () => {
  const { runChild } = fakeChild(new Error("model unavailable"));
  const out = await runPlanScout({ task: BRIEF, cwd: "/repo", runChild });
  assert.equal(out.ok, false);
  assert.match(out.text, /failed: model unavailable/);
});

test("an empty report is not a finding", async () => {
  const { runChild } = fakeChild({ status: "completed", text: "  ", toolUses: 3 });
  const out = await runPlanScout({ task: BRIEF, cwd: "/repo", runChild });
  assert.equal(out.ok, false);
  assert.match(out.text, /no report/i);
});

test("a long report is cut to a readable size, keeping both ends", async () => {
  const text = `START ${"x".repeat(20000)} END`;
  const { runChild } = fakeChild({ status: "completed", text, toolUses: 1 });
  const out = await runPlanScout({ task: BRIEF, cwd: "/repo", runChild });
  assert.ok(out.text.length < 7000, `got ${out.text.length}`);
  assert.match(out.text, /START/);
  assert.match(out.text, /END/);
  assert.match(out.text, /characters cut/);
});
