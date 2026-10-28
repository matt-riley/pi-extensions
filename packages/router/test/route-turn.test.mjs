import { test } from "node:test";
import assert from "node:assert/strict";

import { modelKey } from "../model-battery.mjs";
import {
  decisionReasonFromPlan,
  judgeableTurn,
  planUserRouteTurn,
  readBranchState,
} from "../route-turn.mjs";

const LUNA = { provider: "openai-codex", id: "gpt-5.6-luna" };
const ASTRA = { provider: "openai-codex", id: "gpt-6-astra", contextWindow: 272000 };
const user = (text) => ({ role: "user", content: [{ type: "text", text }] });

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

test("planUserRouteTurn skips the judge when a tier is forced", async () => {
  let judged = false;
  const tiers = {
    base: [{ model: "openai-codex/gpt-5.6-luna", thinking: "medium" }],
    mid: [{ model: "openai-codex/gpt-6-astra", thinking: "low" }],
    frontier: [{ model: "openai-codex/gpt-6-astra", thinking: "medium" }],
  };
  const planned = await planUserRouteTurn({
    messages: [user("audit the routing design")],
    branchState: null,
    previousKey: modelKey(LUNA),
    offers: [LUNA, ASTRA],
    liveOffers: [LUNA, ASTRA],
    tiers,
    ctx: {
      modelRegistry: {
        find: (p, id) => [LUNA, ASTRA].find((m) => m.provider === p && m.id === id) ?? null,
      },
    },
    selected: "medium",
    cooling: [],
    threshold: 1.5,
    frontierThreshold: 2.5,
    timeoutMs: 4000,
    shareWindow: true,
    forcedTier: "frontier",
    judge: async () => {
      judged = true;
      return { answers: { difficulty: { type: "score", score: 0.5 } } };
    },
  });
  assert.equal(judged, false);
  assert.equal(planned.outcome, "forced");
  assert.equal(planned.tier, "frontier");
  assert.equal(planned.state.forcedTier, "frontier");
  assert.equal(decisionReasonFromPlan(planned.decided, planned.outcome), "forced");
});
