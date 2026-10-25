import assert from "node:assert/strict";
import test from "node:test";

import { decideRoute, fitting } from "../decide.mjs";

const base = { provider: "openai-codex", id: "gpt-5.5", contextWindow: 1_000_000 };
const luna = { provider: "openai-codex", id: "gpt-5.6-luna", contextWindow: 272_000 };
const astra = { provider: "openai-codex", id: "gpt-6-astra", contextWindow: 272_000 };
const tiers = {
  base: ["openai-codex/gpt-5.5"],
  mid: ["openai-codex/gpt-5.6-luna"],
  frontier: ["openai-codex/gpt-6-astra"],
};
const offers = [base, luna, astra];
const held = (over = {}) => ({
  key: "openai-codex/gpt-5.5",
  thinking: "medium",
  tier: "base",
  model: base,
  ...over,
});
const baseline = { key: "openai-codex/gpt-5.5", model: base, thinking: "medium" };
const decide = (decided, over = {}) =>
  decideRoute({
    decided,
    offers,
    tiers,
    contextTokens: 10_000,
    held: held(),
    base: baseline,
    selected: "medium",
    boundary: true,
    ...over,
  });

test("a rating of nothing holds what is running", () => {
  const out = decide(null);
  assert.equal(out.outcome, "held");
  assert.equal(out.key, "openai-codex/gpt-5.5");
});

test("an unusable rating is held and named, never a reason to spend less", () => {
  const out = decide({ escalate: null }, { held: held({ tier: "frontier" }) });
  assert.equal(out.outcome, "no-rating");
  assert.equal(out.tier, "frontier");
});

test("a hard task escalates to the tier's model", () => {
  const out = decide({ escalate: true, tier: "frontier", difficulty: 2 });
  assert.equal(out.outcome, "escalated");
  assert.equal(out.key, "openai-codex/gpt-6-astra");
  assert.equal(out.tier, "frontier");
});

test("an easy task steps down only at a task boundary", () => {
  const easy = { escalate: false, difficulty: 0.2 };
  const running = held({ key: "openai-codex/gpt-6-astra", tier: "frontier", model: astra });
  const stuck = decide(easy, { held: running, boundary: false });
  assert.equal(stuck.outcome, "held");
  assert.equal(stuck.key, "openai-codex/gpt-6-astra");

  const next = decide(easy, { held: running, boundary: true });
  assert.equal(next.outcome, "stepped-down");
  assert.equal(next.key, "openai-codex/gpt-5.5");
  assert.equal(next.tier, "base");
});

test("an easy task already on the base is simply held", () => {
  assert.equal(decide({ escalate: false }).outcome, "held");
});

test("a session too big for the target window stays put and says why", () => {
  const out = decide(
    { escalate: true, tier: "frontier", difficulty: 2 },
    { contextTokens: 400_000 },
  );
  assert.equal(out.outcome, "no-frontier-model");
  assert.equal(out.warning, "too-big");
  assert.equal(out.key, "openai-codex/gpt-5.5");
});

test("a tier with no model on offer is reported as unavailable, not too big", () => {
  const out = decide({ escalate: true, tier: "frontier", difficulty: 2 }, { offers: [base, luna] });
  assert.equal(out.warning, "unavailable");
});

test("never escalates sideways or down a tier", () => {
  const running = held({ key: "openai-codex/gpt-6-astra", tier: "frontier", model: astra });
  const out = decide({ escalate: true, tier: "mid", difficulty: 1.6 }, { held: running });
  assert.equal(out.outcome, "held");
  assert.equal(out.key, "openai-codex/gpt-6-astra");
});

test("fitting drops models whose window cannot hold the next request", () => {
  assert.deepEqual(fitting(offers, 400_000), [base]);
  assert.deepEqual(fitting(offers, 10_000), offers);
  assert.deepEqual(fitting([{ id: "unknown" }], 400_000), [{ id: "unknown" }]);
});
