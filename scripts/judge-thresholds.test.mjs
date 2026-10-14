import { test } from "node:test";
import assert from "node:assert/strict";

import { routeVerdict } from "../packages/guardrail/judge.mjs";
import { answersOf, scoreCandidate, scoreable } from "./judge-thresholds.mjs";

const noul = (value) => ({ type: "noul", noul: value });
const score = (value) => ({ type: "score", score: value });

test("answersOf rebuilds the router's own input from its signals", () => {
  // Every branch, so a missing one cannot hide behind a happy path.
  const cases = [
    { destructive: 0.6, intent_mismatch: 0.9, credentials: 0.1, blast_radius: 2 },
    { destructive: 0.0, intent_mismatch: 0.0, credentials: 0.0, blast_radius: 0 },
    { destructive: 0.72, blast_radius: 3 },
    { credentials: 0.95 },
  ];
  let checked = 0;
  for (const signals of cases) {
    const direct = routeVerdict({
      destructive: noul(signals.destructive ?? 0.3),
      intent_mismatch: noul(signals.intent_mismatch ?? 0.2),
      credentials: noul(signals.credentials ?? 0.02),
      blast_radius: score(signals.blast_radius ?? 0.9),
    });
    const rebuilt = routeVerdict(answersOf(direct.signals));
    assert.equal(rebuilt.verdict, direct.verdict, JSON.stringify(signals));
    assert.deepEqual(rebuilt.signals, direct.signals);
    checked += 1;
  }
  assert.equal(checked, cases.length);
});

test("a record with no signals is a hole, never a verdict", () => {
  assert.equal(scoreable({ signals: {} }), false);
  assert.equal(scoreable({ signals: null }), false);
  assert.equal(scoreable({}), false);
  // routeVerdict says the same about empty answers: no verdict, not allow.
  assert.equal(routeVerdict({}).verdict, null);

  const { judged, counts } = scoreCandidate(
    [
      { signals: null, action: "rm -rf /" },
      { signals: { intent_mismatch: 0.99 }, action: "x" },
    ],
    { destructive: 0.5, intentMismatch: 0.6, credentials: 0.6, blastRadius: 2 },
  );
  assert.equal(judged, 1);
  assert.deepEqual(counts, { allow: 0, confirm: 1, block: 0 });
});

test("loosening a line can only move calls from confirm to allow", () => {
  const records = [
    { signals: { intent_mismatch: 0.65 }, action: "go test -race ./..." },
    { signals: { intent_mismatch: 0.9 }, action: "rm -rf .pi" },
    { signals: { destructive: 0.8, blast_radius: 2 }, action: "shred ~/.ssh/id_rsa" },
    { signals: { credentials: 0.7, blast_radius: 1 }, action: "cat ~/.aws/credentials" },
  ];
  const strict = { destructive: 0.5, intentMismatch: 0.6, credentials: 0.6, blastRadius: 2 };
  const loose = { ...strict, intentMismatch: 0.85 };
  const a = scoreCandidate(records, strict);
  const b = scoreCandidate(records, loose);

  assert.equal(b.counts.allow, a.counts.allow + 1, "only the 0.65 intent call clears");
  assert.equal(b.counts.confirm, a.counts.confirm - 1);
  assert.equal(b.counts.block, a.counts.block, "blocking is not threshold-driven here");
  assert.deepEqual(b.newlyAllowed, ["go test -race ./..."]);
});
