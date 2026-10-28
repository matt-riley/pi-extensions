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

test("the medium cap shows mid collapsed onto base and frontier on Astra", () => {
  const ladder = routingLadder({ offers, tiers: DEFAULT_CONFIG, cap: "medium" });
  assert.equal(
    ladder.line,
    "base Luna@medium · mid Luna@medium (same as base) · frontier Astra@medium",
  );
  assert.ok(ladder.warnings.some((warning) => /mid/.test(warning) && /base/.test(warning)));
});

test("the low cap filters mid out and keeps frontier on Astra low", () => {
  const ladder = routingLadder({ offers, tiers: DEFAULT_CONFIG, cap: "low" });
  assert.equal(ladder.line, "base Luna@low · mid (none) · frontier Astra@low");
  assert.ok(ladder.warnings.some((warning) => /mid/.test(warning) && /low/.test(warning)));
});
