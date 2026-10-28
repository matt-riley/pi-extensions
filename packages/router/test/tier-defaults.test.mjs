// Default tier pairs must make mid a real step above base at every thinking cap.
// User router.json overrides these defaults; this file pins the built-in lists only.

import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_CONFIG, readRouterConfig } from "../config.mjs";
import { chooseModelForTier, routeFromDifficulty } from "../model-battery.mjs";
import { routingLadder } from "../ladder.mjs";
import { decideRoute } from "../decide.mjs";

function score(value) {
  return { type: "score", score: value };
}

const offers = [
  { provider: "openai-codex", id: "gpt-5.6-luna" },
  { provider: "openai-codex", id: "gpt-6-astra", contextWindow: 272000 },
  { provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 272000 },
];

const luna = { provider: "openai-codex", id: "gpt-5.6-luna" };

function effectivePair(tier, cap) {
  return chooseModelForTier(offers, tier, DEFAULT_CONFIG, undefined, cap);
}

test("default base names Luna at medium, with a cap fallback entry", () => {
  assert.deepEqual(DEFAULT_CONFIG.base, [
    { model: "openai-codex/gpt-5.6-luna", thinking: "medium" },
    { model: "openai-codex/gpt-5.6-luna" },
  ]);
});

test("default mid prefers Astra low ahead of Luna xhigh", () => {
  assert.equal(DEFAULT_CONFIG.mid[0].model, "openai-codex/gpt-6-astra");
  assert.equal(DEFAULT_CONFIG.mid[0].thinking, "low");
  assert.equal(DEFAULT_CONFIG.mid[1].model, "openai-codex/gpt-5.6-luna");
  assert.equal(DEFAULT_CONFIG.mid[1].thinking, "xhigh");
});

for (const cap of ["low", "medium", "xhigh", "max"]) {
  test(`at the ${cap} cap the effective mid pair differs from base`, () => {
    const base = effectivePair("base", cap);
    const mid = effectivePair("mid", cap);
    assert.ok(base, `base should resolve at ${cap}`);
    assert.ok(mid, `mid should resolve at ${cap}`);
    assert.notEqual(
      `${base.key}@${base.thinking ?? cap}`,
      `${mid.key}@${mid.thinking ?? cap}`,
      `mid must not collapse onto base at ${cap}`,
    );
  });
}

test("at the low cap a mid-rated task can pick a mid model", () => {
  const decided = routeFromDifficulty({ difficulty: score(1.8) });
  assert.equal(decided.tier, "mid");
  const held = {
    key: "openai-codex/gpt-5.6-luna",
    thinking: "low",
    tier: "base",
    model: luna,
  };
  const base = { key: held.key, model: luna, thinking: "low" };
  const out = decideRoute({
    decided,
    offers,
    tiers: DEFAULT_CONFIG,
    contextTokens: 1000,
    held,
    base,
    selected: "low",
    boundary: true,
  });
  assert.equal(out.outcome, "escalated");
  assert.equal(out.key, "openai-codex/gpt-6-astra");
  assert.equal(out.thinking, "low");
  assert.notEqual(out.warning, "unavailable");
});

test("the low-cap ladder keeps mid available and distinct from base", () => {
  const ladder = routingLadder({ offers, tiers: DEFAULT_CONFIG, cap: "low" });
  assert.match(ladder.line, /base Luna@low/);
  assert.match(ladder.line, /mid Astra@low/);
  assert.ok(!ladder.warnings.some((w) => /mid is filtered out/.test(w)));
  assert.ok(!ladder.warnings.some((w) => /mid collapses onto base/.test(w)));
});

test("explicit user mid list overrides the default mid pairs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "router-tier-defaults-"));
  const file = path.join(dir, "router.json");
  const custom = {
    mid: [{ model: "openai-codex/gpt-5.6-luna", thinking: "medium" }],
  };
  fs.writeFileSync(file, JSON.stringify(custom));
  const loaded = readRouterConfig(file);
  const mid = chooseModelForTier(offers, "mid", loaded, undefined, "medium");
  assert.equal(mid.key, "openai-codex/gpt-5.6-luna");
  assert.equal(mid.thinking, "medium");
  assert.deepEqual(loaded.base, DEFAULT_CONFIG.base, "unspecified keys keep defaults");
  fs.rmSync(dir, { recursive: true, force: true });
});
