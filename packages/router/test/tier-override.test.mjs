import { test } from "node:test";
import assert from "node:assert/strict";

import { parseTierOverridePrefix, forcedTierDecision } from "../tier-override.mjs";

test("parseTierOverridePrefix accepts !frontier !mid !base at the start", () => {
  assert.deepEqual(parseTierOverridePrefix("!frontier audit the design"), {
    tier: "frontier",
    rest: "audit the design",
  });
  assert.deepEqual(parseTierOverridePrefix("!MID fix tests"), {
    tier: "mid",
    rest: "fix tests",
  });
  assert.deepEqual(parseTierOverridePrefix("!Base\twhat is this"), {
    tier: "base",
    rest: "what is this",
  });
});

test("parseTierOverridePrefix allows tier-only messages", () => {
  assert.deepEqual(parseTierOverridePrefix("!frontier"), { tier: "frontier", rest: "" });
});

test("parseTierOverridePrefix rejects near misses", () => {
  assert.equal(parseTierOverridePrefix("!frontierx nope"), null);
  assert.equal(parseTierOverridePrefix("please !frontier nope"), null);
  assert.equal(parseTierOverridePrefix("!"), null);
});

test("forcedTierDecision marks a tier without a judge score", () => {
  const decided = forcedTierDecision("mid");
  assert.equal(decided.forced, true);
  assert.equal(decided.tier, "mid");
  assert.equal(decided.escalate, true);
  assert.equal(decided.difficulty, null);
});
