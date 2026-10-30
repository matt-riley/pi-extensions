import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  STUCK_LENGTH_MULTIPLIER,
  STUCK_MIN_FAILURES,
  gateTurn,
  isStuckTurn,
  stuckCheckDescription,
} from "../lib.mjs";
import {
  baselinePath,
  formatRepoKey,
  readBaselineStore,
  recordGoodTurnLength,
  stuckBaselineSnapshot,
  turnEndedWell,
  writeBaselineStoreAtomic,
} from "../turn-baseline.mjs";
import { judgeableTurn } from "../route-turn.mjs";

function turnWithTools(prompt, toolCount, failures = 0) {
  const toolCalls = [];
  for (let i = 0; i < toolCount; i++) {
    const isError = i >= toolCount - failures;
    toolCalls.push({ name: "read", isError });
  }
  return { prompt, toolCalls };
}

function turnWithFailures(prompt, failures, extraOk = 0) {
  const toolCalls = [];
  for (let i = 0; i < extraOk; i++) toolCalls.push({ name: "read", isError: false });
  for (let i = 0; i < failures; i++) toolCalls.push({ name: "bash", isError: true });
  return { prompt, toolCalls };
}

const followUp = "still failing. third time. find the actual race";
const frustratedPrevious = "fix the flaky CI on subagent spawn test, investigate the race";

test("isStuckTurn cold start matches the old two-failure rule", () => {
  const baseline = stuckBaselineSnapshot([4, 4, 4], { PI_ROUTER_STUCK_BASELINE: "on" });
  assert.equal(baseline.adaptive, false);
  assert.equal(baseline.toolCallThreshold, STUCK_MIN_FAILURES);
  assert.equal(isStuckTurn(turnWithFailures("x", 2), baseline), true);
  assert.equal(isStuckTurn(turnWithFailures("x", 1), baseline), false);
});

test("isStuckTurn after five good turns requires length as well as failures", () => {
  const counts = [4, 6, 6, 8, 10];
  const baseline = stuckBaselineSnapshot(counts, { PI_ROUTER_STUCK_BASELINE: "on" });
  assert.equal(baseline.adaptive, true);
  assert.equal(baseline.goodTurnCount, 5);
  assert.equal(baseline.medianToolCalls, 6);
  const expectedThreshold = Math.max(STUCK_MIN_FAILURES, Math.ceil(STUCK_LENGTH_MULTIPLIER * 6));
  assert.equal(baseline.toolCallThreshold, expectedThreshold);
  assert.equal(expectedThreshold, 15);

  const short = turnWithTools(frustratedPrevious, 10, 2);
  assert.equal(isStuckTurn(short, baseline), false);

  const long = turnWithTools(frustratedPrevious, 15, 2);
  assert.equal(isStuckTurn(long, baseline), true);
});

test("turnEndedWell excludes turns whose last tool call failed", () => {
  assert.equal(turnEndedWell({ toolCalls: [{ name: "read", isError: false }] }), true);
  assert.equal(turnEndedWell({ toolCalls: [] }), true);
  assert.equal(
    turnEndedWell({
      toolCalls: [
        { name: "read", isError: false },
        { name: "bash", isError: true },
      ],
    }),
    false,
  );
});

test("recordGoodTurnLength keeps at most fifty lengths per repository", () => {
  const file = path.join(os.tmpdir(), `router-baseline-${process.pid}-cap.json`);
  const repo = "/tmp/repo-a";
  try {
    for (let i = 1; i <= 51; i++) recordGoodTurnLength(file, repo, i);
    const store = readBaselineStore(file);
    assert.equal(store.repos[repo].length, 50);
    assert.deepEqual(store.repos[repo].slice(0, 3), [2, 3, 4]);
    assert.equal(store.repos[repo].at(-1), 51);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("baseline lengths are separated per git root key", () => {
  const file = path.join(os.tmpdir(), `router-baseline-${process.pid}-repos.json`);
  try {
    recordGoodTurnLength(file, "/repo/one", 3);
    recordGoodTurnLength(file, "/repo/two", 9);
    const store = readBaselineStore(file);
    assert.deepEqual(store.repos["/repo/one"], [3]);
    assert.deepEqual(store.repos["/repo/two"], [9]);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("PI_ROUTER_STUCK_BASELINE=off restores the fixed failure rule", () => {
  const warm = stuckBaselineSnapshot([6, 6, 6, 6, 6, 6, 6], {
    PI_ROUTER_STUCK_BASELINE: "off",
  });
  assert.equal(warm.adaptive, false);
  const short = turnWithTools(frustratedPrevious, 10, 2);
  assert.equal(isStuckTurn(short, warm), true);
});

test("a corrupt baseline file falls back without throwing", () => {
  const file = path.join(os.tmpdir(), `router-baseline-${process.pid}-bad.json`);
  try {
    fs.writeFileSync(file, "{ not json\n", "utf8");
    const store = readBaselineStore(file);
    assert.deepEqual(store.repos, {});
    const snap = stuckBaselineSnapshot([], { PI_ROUTER_STUCK_BASELINE: "on" });
    assert.equal(snap.adaptive, false);
    assert.doesNotThrow(() => writeBaselineStoreAtomic(file, { repos: { x: [1] } }));
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test("gateTurn and judgeableTurn share isStuckTurn on a warm baseline", () => {
  const baseline = stuckBaselineSnapshot([6, 6, 6, 6, 6], { PI_ROUTER_STUCK_BASELINE: "on" });
  const previous = turnWithTools(frustratedPrevious, 10, 2);
  const boundary = gateTurn({ prompt: followUp, previousTurn: previous, baseline });
  assert.equal(boundary.route, true, "short failing turn is a topic shift when adaptive");
  assert.equal(boundary.reason, "topic shift");

  const { worthJudging, judgeable } = judgeableTurn({
    prompt: followUp,
    boundary,
    previousTurn: previous,
    baseline,
    attempts: 1,
    cooldown: 0,
  });
  assert.equal(worthJudging, true, "topic shift still worth judging");
  assert.equal(judgeable, true);

  const longPrevious = turnWithTools(frustratedPrevious, 15, 2);
  const stuckBoundary = gateTurn({ prompt: followUp, previousTurn: longPrevious, baseline });
  assert.equal(stuckBoundary.route, false);
  assert.equal(stuckBoundary.reason, "stuck continuation");
  const stuckJudge = judgeableTurn({
    prompt: followUp,
    boundary: stuckBoundary,
    previousTurn: longPrevious,
    baseline,
    attempts: 1,
    cooldown: 0,
  });
  assert.equal(stuckJudge.worthJudging, true);
  assert.equal(stuckJudge.judgeable, true);
});

test("gateTurn cold start behaviour is unchanged", () => {
  const baseline = stuckBaselineSnapshot([], { PI_ROUTER_STUCK_BASELINE: "on" });
  const previous = turnWithFailures(frustratedPrevious, 2);
  const result = gateTurn({ prompt: followUp, previousTurn: previous, baseline });
  assert.equal(result.route, false);
  assert.equal(result.reason, "stuck continuation");
});

test("stuckCheckDescription formats the baseline line for preview", () => {
  const baseline = stuckBaselineSnapshot([6, 6, 6, 6, 6, 6, 6], {
    PI_ROUTER_STUCK_BASELINE: "on",
  });
  assert.equal(
    stuckCheckDescription(baseline),
    "stuck check: baseline 7 turns, median 6 calls, threshold 15",
  );
});

test("baselinePath lives under the agent directory", () => {
  assert.equal(
    baselinePath({ PI_CODING_AGENT_DIR: "/tmp/agent-dir" }),
    "/tmp/agent-dir/router-turn-baseline.json",
  );
});

test("formatRepoKey normalises git roots", () => {
  assert.equal(formatRepoKey("/foo/bar/"), "/foo/bar");
});
