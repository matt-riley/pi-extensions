import { test } from "node:test";
import assert from "node:assert/strict";

import {
  attemptMessage,
  climbKickoff,
  decideClimb,
  hypothesisOf,
  idleMessage,
  median,
  parseClimbArgs,
} from "../climb.mjs";
import { RULE } from "../loop.mjs";
import { parseCounters, rangesOverlap, summarize } from "../../../shared/measure.mjs";

test("parses status, stop, flags, a quoted gate, the metric and the task", () => {
  assert.deepEqual(parseClimbArgs(""), { kind: "status" });
  assert.deepEqual(parseClimbArgs(" stop "), { kind: "stop" });
  assert.deepEqual(
    parseClimbArgs(
      '--max 5 --min 2 --runs 4 --higher --target 90 --gate "npm test -- --grep x" node bench.mjs -- speed up parsing',
    ),
    {
      kind: "start",
      metric: "node bench.mjs",
      task: "speed up parsing",
      max: 5,
      min: 2,
      runs: 4,
      direction: "higher",
      target: 90,
      gate: "npm test -- --grep x",
    },
  );
  const defaults = parseClimbArgs("--target 25 --gate 'npm test' ./metric.sh");
  assert.equal(defaults.kind, "start");
  assert.equal(defaults.direction, "lower");
  assert.equal(defaults.max, 20);
  assert.equal(defaults.runs, 3);
  assert.equal(defaults.gate, "npm test");
  assert.equal(defaults.metric, "./metric.sh");
});

test("rejects missing or malformed arguments", () => {
  assert.equal(parseClimbArgs("--gate true ./m.sh").kind, "error");
  assert.equal(parseClimbArgs("--target 1 ./m.sh").kind, "error");
  assert.equal(parseClimbArgs("--target fast --gate true ./m.sh").kind, "error");
  assert.equal(parseClimbArgs("--target 1 --gate true").kind, "error");
  assert.equal(parseClimbArgs("--runs 2 --target 1 --gate true ./m.sh").kind, "error");
  assert.equal(parseClimbArgs("--min 5 --max 2 --target 1 --gate true ./m.sh").kind, "error");
  assert.equal(parseClimbArgs("--max 0 --target 1 --gate true ./m.sh").kind, "error");
});

test("median handles odd and even counts", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

const loop = {
  best: { median: 33.1, min: 32.4, max: 35 },
  direction: "lower",
  target: 25,
  min: 1,
  max: 20,
  iteration: 3,
  kept: 1,
};

test("an attempt whose range overlaps the best is rejected", () => {
  const d = decideClimb(loop, { gateCode: 0, samples: [31.9, 32.8, 34.6], workOk: true });
  assert.equal(d.action, "continue");
  assert.equal(d.iteration, 4);
  assert.equal(d.verdict.keep, false);
  assert.equal(d.verdict.why, "ranges overlap the best accepted run");
});

test("an attempt that clears the best range is kept", () => {
  const d = decideClimb(loop, { gateCode: 0, samples: [30, 29, 31], workOk: true });
  assert.equal(d.verdict.keep, true);
  assert.equal(d.kept, 2);
  assert.equal(d.verdict.why, "median 33.1 -> 30");
});

test("higher is better when the loop says so", () => {
  const up = { ...loop, direction: "higher", best: { median: 10, min: 9, max: 11 }, target: 20 };
  assert.equal(
    decideClimb(up, { gateCode: 0, samples: [12, 13, 14], workOk: true }).verdict.keep,
    true,
  );
  assert.equal(
    decideClimb(up, { gateCode: 0, samples: [8, 7, 6], workOk: true }).verdict.keep,
    false,
  );
});

test("a red gate or missing work rejects whatever the numbers say", () => {
  const red = decideClimb(loop, { gateCode: 1, samples: [], workOk: false });
  assert.equal(red.verdict.keep, false);
  assert.equal(red.verdict.why, "gate exited 1");
  const noWork = decideClimb(loop, {
    gateCode: 0,
    samples: [],
    workOk: false,
    why: "metric exited 2",
  });
  assert.equal(noWork.verdict.why, "metric exited 2");
});

test("the target ends the loop only after the attempt floor", () => {
  const win = { gateCode: 0, samples: [20, 21, 22], workOk: true };
  assert.equal(decideClimb(loop, win).action, "done");
  assert.equal(decideClimb({ ...loop, min: 10 }, win).action, "continue");
});

test("the cap ends the loop", () => {
  const d = decideClimb(
    { ...loop, iteration: 19 },
    { gateCode: 0, samples: [34, 34, 34], workOk: true },
  );
  assert.equal(d.action, "cap");
});

test("a rejection tells the agent to revert in full and stop, with the rule", () => {
  const d = decideClimb(loop, { gateCode: 0, samples: [31.9, 32.8, 34.6], workOk: true });
  const message = attemptMessage(loop, d);
  assert.match(
    message,
    /^\/climb attempt 4\/20: rejected \(ranges overlap the best accepted run\)\./,
  );
  assert.ok(
    message.includes(
      "Revert this attempt in full, then stop so I can confirm the tree matches the last accepted state.",
    ),
  );
  assert.ok(message.includes(RULE));
});

test("a kept attempt never commits on its own", () => {
  const d = decideClimb(loop, { gateCode: 0, samples: [30, 29, 31], workOk: true });
  assert.ok(
    attemptMessage(loop, d).includes(
      "/climb never commits; commit it only if the user has authorised commits.",
    ),
  );
});

test("kickoff and idle messages ask for one named change", () => {
  const kickoff = climbKickoff({ ...loop, metric: "./m.sh", gate: "npm test", runs: 3, task: "" });
  assert.match(kickoff, /^Move `\.\/m\.sh` down to 25\./);
  assert.ok(kickoff.includes("start your last message with `Hypothesis: <mechanism>`"));
  assert.match(idleMessage("unreverted"), /does not match the last accepted state/);
  assert.match(idleMessage("reverted"), /^\/climb: revert confirmed\./);
  assert.match(idleMessage("unchanged"), /nothing changed since the last accepted state/);
});

test("the hypothesis comes from a named line, else the first line", () => {
  assert.equal(
    hypothesisOf("Done.\n**Hypothesis:** cache the `parse` result"),
    "cache the parse result",
  );
  assert.equal(hypothesisOf("Inlined the hot loop.\nMore text"), "Inlined the hot loop.");
  assert.equal(hypothesisOf(""), "");
});

test("shared counters reject zero, cached and non-JSON work", () => {
  assert.deepEqual(parseCounters('{"value": 4, "completed": 1, "cached": 0}\n'), {
    value: 4,
    completed: 1,
    cached: 0,
  });
  assert.throws(() => parseCounters('{"completed": 0, "cached": 0}'), /nonzero/);
  assert.throws(() => parseCounters('{"completed": 3, "cached": 0}', 4), /exactly match/);
  assert.throws(() => parseCounters('{"completed": 3, "cached": 1}'), /Cached/);
  assert.throws(() => parseCounters("fast"), /only JSON counters/);
  assert.equal(summarize([1, 2, 3]).mean, 2);
  assert.equal(rangesOverlap({ min: 1, max: 3 }, { min: 3, max: 5 }), true);
  assert.equal(rangesOverlap({ min: 1, max: 2 }, { min: 3, max: 5 }), false);
});
