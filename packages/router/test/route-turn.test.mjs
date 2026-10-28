import { test } from "node:test";
import assert from "node:assert/strict";

import { judgeableTurn, planUserRouteTurn, readBranchState } from "../route-turn.mjs";

test("readBranchState rejects malformed routing state", () => {
  assert.equal(readBranchState(null), null);
  assert.equal(readBranchState({ task: 1 }), null);
});

test("judgeableTurn matches the router budget rule", () => {
  const boundary = { route: false, reason: "looks like a continuation" };
  assert.equal(
    judgeableTurn({ prompt: "hi", boundary, failuresLastTurn: 0, attempts: 1, cooldown: 0 })
      .judgeable,
    false,
  );
  assert.equal(
    judgeableTurn({ prompt: "hi", boundary, failuresLastTurn: 2, attempts: 1, cooldown: 0 })
      .judgeable,
    true,
  );
});

test("planUserRouteTurn is exported for shadow parity", () => {
  assert.equal(typeof planUserRouteTurn, "function");
});
