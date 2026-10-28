import assert from "node:assert/strict";
import { test } from "node:test";

import { sessionEscalationMetrics, turnCatchLabel } from "./difficulty-report-lib.mjs";
import { DIFFICULTY_THRESHOLD } from "../packages/router/model-battery.mjs";

test("turnCatchLabel uses the router difficulty threshold, not needs_frontier", () => {
  assert.equal(turnCatchLabel({ difficulty: 1.5 }), "caught");
  assert.equal(turnCatchLabel({ difficulty: 1.49 }), "MISSED");
  assert.equal(turnCatchLabel({ difficulty: 2.8 }), "caught");
  assert.equal(turnCatchLabel({ difficulty: null }), null);
});

test("turnCatchLabel reuses an explicit threshold override", () => {
  assert.equal(turnCatchLabel({ difficulty: 1.2 }, { threshold: 1.0 }), "caught");
  assert.equal(turnCatchLabel({ difficulty: 1.2 }), "MISSED");
});

test("sessionEscalationMetrics scores sessions from max difficulty at the router threshold", () => {
  const rows = [
    { file: "a.jsonl", frontier: true, difficulty: 1.0 },
    { file: "a.jsonl", frontier: false, difficulty: 1.6 },
    { file: "b.jsonl", frontier: true, difficulty: 1.2 },
    { file: "c.jsonl", frontier: false, difficulty: 0.5 },
    { file: "d.jsonl", frontier: false, difficulty: 2.0 },
  ];
  const metrics = sessionEscalationMetrics(rows);
  assert.equal(metrics.sessions, 4);
  assert.equal(metrics.tp, 1);
  assert.equal(metrics.fp, 1);
  assert.equal(metrics.fn, 1);
  assert.equal(metrics.threshold, DIFFICULTY_THRESHOLD);
});
