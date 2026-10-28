// The ladder is a report of what each tier resolves to at the current thinking
// cap. It does not change which model a turn gets.

import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_CONFIG } from "../config.mjs";
import { routingLadder } from "../ladder.mjs";

const offers = [
  { provider: "openai-codex", id: "gpt-5.6-luna" },
  { provider: "openai-codex", id: "gpt-6-astra", contextWindow: 272000 },
  { provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 272000 },
];

test("the medium cap separates base, mid and frontier", () => {
  const ladder = routingLadder({ offers, tiers: DEFAULT_CONFIG, cap: "medium" });
  assert.equal(ladder.line, "base Luna@medium · mid Astra@low · frontier Astra@medium");
  assert.equal(ladder.warnings.length, 0);
});

test("the low cap keeps mid on Astra low with base on Luna low", () => {
  const ladder = routingLadder({ offers, tiers: DEFAULT_CONFIG, cap: "low" });
  assert.equal(ladder.line, "base Luna@low · mid Astra@low · frontier Astra@low");
  assert.equal(ladder.warnings.length, 0);
});
