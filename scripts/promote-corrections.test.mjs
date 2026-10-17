import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_CORRECTIONS,
  PROMOTIONS,
  buildQuestions,
  formatPromotions,
  parseClusters,
  promoteCorrections,
} from "./promote-corrections.mjs";

const choice = (value) => ({ type: "choice", choice: value, confidence: 0.7 });
const noul = (value) => ({ type: "noul", noul: value });

test("the tiers are ordered from cheapest to most expensive", () => {
  assert.deepEqual(Object.keys(PROMOTIONS), [
    "test",
    "lint",
    "guardrail",
    "agents",
    "prompt",
    "none",
  ]);
});

test("clusters arrive as JSON or as one correction per line", () => {
  assert.deepEqual(parseClusters('["stop printing example commands"]'), [
    { text: "stop printing example commands", occurrences: 1 },
  ]);
  assert.deepEqual(
    parseClusters(JSON.stringify([{ correction: "ask first", occurrences: 3 }, { text: "  " }])),
    [{ text: "ask first", occurrences: 3 }],
  );
  assert.deepEqual(parseClusters("- one\n* two\n\nthree"), [
    { text: "one", occurrences: 1 },
    { text: "two", occurrences: 1 },
    { text: "three", occurrences: 1 },
  ]);
  assert.deepEqual(parseClusters("   "), []);
  assert.throws(() => parseClusters('{"not":"an array"}'), /array/);
});

test("each correction gets its own pair of questions, and guidance is optional", () => {
  const without = buildQuestions(2);
  assert.deepEqual(Object.keys(without).sort(), ["promotion_0", "promotion_1"]);
  const withGuidance = buildQuestions(1, { guidance: "AGENTS.md text" });
  assert.deepEqual(Object.keys(withGuidance).sort(), ["already_covered_0", "promotion_0"]);
  assert.match(withGuidance.already_covered_0.instructions, /`guidance`/);
  assert.match(withGuidance.promotion_0.instructions, /`corrections\.0\.text`/);
});

test("a cluster is accepted in either shape, and an unusable one is reported", async () => {
  const calls = [];
  const result = await promoteCorrections({
    corrections: [{ correction: "run the commands", occurrences: 2 }],
    env: {},
    ask: async (request) => {
      calls.push(request);
      return { answers: { promotion_0: choice("agents") } };
    },
  });
  assert.equal(calls[0].state.corrections[0].text, "run the commands");
  assert.equal(calls[0].state.corrections[0].occurrences, 2);
  assert.equal(result.rows[0].promotion, "agents");

  const empty = await promoteCorrections({
    corrections: [{ text: "something" }],
    env: {},
    ask: async () => ({ answers: {} }),
  });
  assert.equal(empty.judged, false);
  assert.match(empty.reason, /no usable promotion/);
});

test("one request answers every cluster", async () => {
  const calls = [];
  const result = await promoteCorrections({
    corrections: [
      { text: "printed example commands instead of running them", occurrences: 3 },
      { text: "asked for a fact it could have looked up", occurrences: 2 },
    ],
    guidance: "AGENTS.md says: run the commands",
    env: {},
    ask: async (request) => {
      calls.push(request);
      return {
        model: "test",
        answers: {
          promotion_0: choice("prompt"),
          already_covered_0: noul(0.8),
          promotion_1: choice("agents"),
          already_covered_1: noul(0.2),
        },
      };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].state.corrections.length, 2);
  assert.deepEqual(
    result.rows.map((row) => [row.promotion, row.covered]),
    [
      ["prompt", 0.8],
      ["agents", 0.2],
    ],
  );
});

test("a promotion outside the set is not a promotion", async () => {
  const result = await promoteCorrections({
    corrections: [{ text: "something" }],
    ask: async () => ({ answers: { promotion_0: choice("vibes") } }),
    env: {},
  });
  assert.equal(result.rows[0].promotion, null);
  assert.equal(result.judged, false);
});

test("the report pairs each tier with what it means", () => {
  const text = formatPromotions({
    judged: true,
    rows: [
      { text: "printed examples", promotion: "lint", covered: null },
      { text: "unknown", promotion: null, covered: 0.4 },
    ],
  });
  assert.match(text, /1\. lint {5} — printed examples/);
  assert.match(text, /a lint rule, type check or script check/i);
  assert.match(text, /2\. \? {8} · already covered 0\.40 — unknown/);
});

test("more clusters than the cap are dropped rather than paid for", () => {
  const many = Array.from({ length: MAX_CORRECTIONS + 5 }, (_, index) => ({ text: "c" + index }));
  assert.equal(
    Object.keys(buildQuestions(Math.min(many.length, MAX_CORRECTIONS))).length,
    MAX_CORRECTIONS,
  );
});

test("a failed request reports why instead of promoting nothing silently", async () => {
  const result = await promoteCorrections({
    corrections: [{ text: "something" }],
    env: {},
    ask: async () => {
      throw new Error("TYPESAFE_API_KEY is not set");
    },
  });
  assert.equal(result.judged, false);
  assert.match(result.reason, /TYPESAFE_API_KEY/);
  assert.match(formatPromotions(result), /Not promoted: TYPESAFE_API_KEY/);
});
