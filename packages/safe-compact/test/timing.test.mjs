import { test } from "node:test";
import assert from "node:assert/strict";

import {
  THRESHOLDS,
  boundaryTimingEnabled,
  decideCompactionTiming,
  isSafeBoundary,
} from "../timing.mjs";

test("isSafeBoundary: only compact when confident (precision over recall)", () => {
  assert.equal(isSafeBoundary({ midFlight: 0.9, completed: 0.1, debugging: 0.1 }), false);
  assert.equal(isSafeBoundary({ midFlight: 0.1, completed: 0.1, debugging: 0.9 }), false);
  assert.equal(isSafeBoundary({ midFlight: 0.1, completed: 0.1, debugging: 0.1 }), true);
  assert.equal(isSafeBoundary({ midFlight: 0.9, completed: 0.9, debugging: 0.1 }), true);
  assert.equal(isSafeBoundary({ midFlight: null, completed: 0.9, debugging: 0.1 }), false);
});

test("isSafeBoundary: a task switch that needs little history can be safe while unfinished", () => {
  const switched = {
    compared: true,
    midFlight: 0.45,
    completed: 0.1,
    debugging: 0.1,
    switched: 0.9,
    needsHistory: 0.2,
  };
  assert.equal(isSafeBoundary(switched), true);
  assert.equal(isSafeBoundary({ ...switched, needsHistory: 1.6 }), false);
  assert.equal(isSafeBoundary({ ...switched, midFlight: 0.8 }), false);
  assert.equal(isSafeBoundary({ ...switched, compared: false }), false);
});

test("decideCompactionTiming: ceiling forces compaction even when the boundary is not safe", () => {
  const args = { soft: 50, hard: 70, timingEnabled: true, safe: false, judgeFailed: false };
  assert.equal(decideCompactionTiming({ ...args, percent: 75 }), "compact");
  assert.equal(decideCompactionTiming({ ...args, percent: 70 }), "compact");
  assert.equal(decideCompactionTiming({ ...args, percent: 60 }), "wait");
});

test("decideCompactionTiming: mid-task defers between soft and hard when timing is on", () => {
  const args = { soft: 50, hard: 70, timingEnabled: true, judgeFailed: false };
  assert.equal(decideCompactionTiming({ ...args, percent: 40, safe: true }), "none");
  assert.equal(decideCompactionTiming({ ...args, percent: 60, safe: true }), "compact");
  assert.equal(decideCompactionTiming({ ...args, percent: 60, safe: false }), "wait");
});

test("decideCompactionTiming: judge failure is not safe but the ceiling still compacts", () => {
  const args = { soft: 50, hard: 70, timingEnabled: true, safe: false };
  assert.equal(decideCompactionTiming({ ...args, percent: 60, judgeFailed: true }), "wait");
  assert.equal(decideCompactionTiming({ ...args, percent: 70, judgeFailed: true }), "compact");
});

test("decideCompactionTiming: overflow is a hard ceiling that never waits", () => {
  const args = {
    soft: 50,
    hard: 70,
    timingEnabled: true,
    safe: false,
    judgeFailed: true,
    percent: 65,
  };
  assert.equal(decideCompactionTiming({ ...args, overflow: false }), "wait");
  assert.equal(decideCompactionTiming({ ...args, overflow: true }), "compact");
});

test("decideCompactionTiming: timing off compacts between soft and hard without deferral", () => {
  const args = { soft: 50, hard: 70, timingEnabled: false, safe: false, judgeFailed: true };
  assert.equal(decideCompactionTiming({ ...args, percent: 60 }), "compact");
});

test("boundaryTimingEnabled is off unless the flag or env opts in", () => {
  assert.equal(boundaryTimingEnabled({ getFlag: () => undefined }, {}), false);
  assert.equal(boundaryTimingEnabled({ getFlag: () => true }, {}), true);
  assert.equal(
    boundaryTimingEnabled({ getFlag: () => undefined }, { PI_SAFE_COMPACT_BOUNDARY_TIMING: "1" }),
    true,
  );
});

test("THRESHOLDS records the tuned model beside the measured lines", () => {
  assert.match(THRESHOLDS.tunedModel, /^jev-/);
  assert.ok(typeof THRESHOLDS.completed === "number");
});
