import { test } from "node:test";
import assert from "node:assert/strict";

import {
  decisionStats,
  MIN_BAND_SAMPLE,
  thresholdPosition,
  frontierEpisodes,
  isFrontierModel,
  percentile,
  requestSeries,
  ratingBuckets,
  switchCosts,
  switchPoints,
} from "../metrics.mjs";

const PATTERNS = ["gpt-6-astra", "gpt-5.6-sol"];

// A stored request, as a session holds it; metrics run it through requestSeries.
function request(
  model,
  { cost = 0.01, context = 1000, input = 100, cacheRead = 900, cacheWrite = 0, output = 10 } = {},
) {
  return { model, context, input, cacheRead, cacheWrite, output, cost: { total: cost } };
}

/** The flattened series the metrics actually consume. */
function seriesOf(requests) {
  return requestSeries(sessionWith([turn("p", requests)]));
}

function sessionWith(turns, { entries = [], modelChanges = [] } = {}) {
  return { turns, entries, modelChanges, compactions: [] };
}

function turn(prompt, requests, toolCalls = []) {
  return { prompt, requests, toolCalls, lastResponse: "", contextTokens: 0 };
}

// ---------------------------------------------------------------------------

test("isFrontierModel matches substrings of provider/model", () => {
  assert.equal(isFrontierModel("openai-codex/gpt-6-astra", PATTERNS), true);
  assert.equal(isFrontierModel("deepseek/deepseek-flash", PATTERNS), false);
  assert.equal(isFrontierModel(null, PATTERNS), false);
  assert.equal(isFrontierModel("anything", []), false);
});

test("requestSeries flattens turns in order and carries failures", () => {
  const session = sessionWith([
    turn("first", [request("a/one"), request("a/one")], [{ name: "bash", isError: true }]),
    turn("second", [request("b/two")]),
  ]);
  const series = requestSeries(session);
  assert.equal(series.length, 3);
  assert.deepEqual(
    series.map((r) => r.model),
    ["a/one", "a/one", "b/two"],
  );
  assert.equal(series[0].failures, 1);
  assert.equal(series[2].failures, 0);
  assert.equal(series[0].prompt, "first");
});

// ---------------------------------------------------------------------------
// Switch cost: the thing the audit said was never measured

test("switchPoints finds where the model changed", () => {
  const series = seriesOf([request("a"), request("a"), request("b"), request("b"), request("a")]);
  assert.deepEqual(switchPoints(series), [2, 4]);
});

test("switchCosts prices the cold prefill and the wait to rewarm", () => {
  const series = seriesOf([
    request("cheap", { cost: 0.001, input: 5, cacheRead: 995, cacheWrite: 0 }),
    request("cheap", { cost: 0.001, input: 5, cacheRead: 995, cacheWrite: 0 }),
    // The switch: the destination reads everything fresh and writes cache.
    request("frontier", { cost: 0.9, context: 1000, input: 800, cacheRead: 0, cacheWrite: 200 }),
    request("frontier", { cost: 0.5, context: 1200, input: 400, cacheRead: 800, cacheWrite: 0 }),
    request("frontier", { cost: 0.1, context: 1400, input: 100, cacheRead: 1300, cacheWrite: 0 }),
  ]);
  const [cost] = switchCosts(series);
  assert.equal(cost.from, "cheap");
  assert.equal(cost.to, "frontier");
  assert.equal(cost.coldTokens, 1000, "fresh input plus cache writes");
  assert.equal(cost.coldCost, 0.9);
  // The very next request after the cold one is already mostly cache reads
  // (800 of 1200), so the destination took one request to rewarm.
  assert.equal(cost.rewarmRequests, 1);
});

test("a switch that never rewarns says so instead of pretending", () => {
  const series = seriesOf([
    request("cheap"),
    request("frontier", { input: 1000, cacheRead: 0, cacheWrite: 0 }),
    request("frontier", { input: 1100, cacheRead: 0, cacheWrite: 0 }),
  ]);
  assert.equal(switchCosts(series)[0].rewarmRequests, null);
});

// ---------------------------------------------------------------------------
// Frontier episodes

test("frontierEpisodes groups contiguous frontier runs and prices the delta", () => {
  const session = sessionWith([
    turn("start", [
      request("deepseek/deepseek-flash", { cost: 0.01 }),
      request("deepseek/deepseek-flash", { cost: 0.01 }),
      request("openai-codex/gpt-6-astra", { cost: 0.5 }),
      request("openai-codex/gpt-6-astra", { cost: 0.5 }),
      request("deepseek/deepseek-flash", { cost: 0.01 }),
    ]),
  ]);
  const episodes = frontierEpisodes(session, { patterns: PATTERNS });
  assert.equal(episodes.length, 1);
  const [episode] = episodes;
  assert.equal(episode.requests, 2);
  assert.equal(episode.cost, 1);
  assert.equal(episode.perRequest, 0.5);
  assert.equal(episode.baselinePerRequest, 0.01);
  assert.ok(Math.abs(episode.extraCost - 0.98) < 1e-9, "two requests at 0.5 vs 0.01 each");
  assert.equal(episode.firstPrompt, "start");
  // Failures are per turn and must not be multiplied by the request count.
  assert.equal(episode.failuresPerTurn, 0);
});

test("a turn failure is counted once however many requests it made", () => {
  const session = sessionWith([
    turn(
      "failing",
      [
        request("openai-codex/gpt-6-astra"),
        request("openai-codex/gpt-6-astra"),
        request("openai-codex/gpt-6-astra"),
      ],
      [
        { name: "bash", isError: true },
        { name: "bash", isError: true },
      ],
    ),
  ]);
  const [episode] = frontierEpisodes(session, { patterns: PATTERNS });
  assert.equal(episode.requests, 3);
  assert.equal(episode.failures, 2, "two failures, not two times three");
  assert.equal(episode.turns, 1);
  assert.equal(episode.failuresPerTurn, 2);
  assert.equal(episode.failureShare, 1, "one turn, and it had failures");
  assert.equal(episode.cacheShare, 0.9, "900 of 1000 context tokens were cache reads");
});

test("frontierEpisodes reports no delta when the session never ran cheaper", () => {
  const session = sessionWith([
    turn("all frontier", [
      request("openai-codex/gpt-6-astra"),
      request("openai-codex/gpt-6-astra"),
    ]),
  ]);
  const [episode] = frontierEpisodes(session, { patterns: PATTERNS });
  assert.equal(episode.baselinePerRequest, null);
  assert.equal(episode.extraCost, null);
});

// ---------------------------------------------------------------------------
// Calibration from the router's own decisions

test("a held decision followed by a manual escalation is a miss", () => {
  const session = sessionWith([], {
    entries: [
      {
        customType: "router-decision",
        at: 1000,
        data: { outcome: "held", difficulty: 1.2, threshold: 1.5 },
      },
    ],
    modelChanges: [{ at: 2000, provider: "openai-codex", model: "gpt-6-astra" }],
  });
  const stats = decisionStats(session, { patterns: PATTERNS });
  assert.equal(stats.missed.length, 1);
  assert.equal(stats.missed[0].rating, 1.2);
  assert.equal(stats.needless.length, 0);
});

test("the router's own switch is not counted against it", () => {
  const session = sessionWith([], {
    entries: [
      {
        customType: "router-decision",
        at: 1000,
        data: { outcome: "held", difficulty: 0.4, threshold: 1.5 },
      },
      {
        customType: "router-decision",
        at: 1010,
        data: { outcome: "escalated", difficulty: 2.4, to: "openai-codex/gpt-6-astra" },
      },
    ],
    modelChanges: [{ at: 1012, provider: "openai-codex", model: "gpt-6-astra" }],
  });
  const stats = decisionStats(session, { patterns: PATTERNS });
  assert.equal(
    stats.missed.length,
    0,
    "the rising model change belongs to the escalation, not the hold",
  );
});

test("an escalation followed by a manual retreat is needless", () => {
  const session = sessionWith([], {
    entries: [
      {
        customType: "router-decision",
        at: 1000,
        data: { outcome: "escalated", difficulty: 1.6, to: "openai-codex/gpt-6-astra" },
      },
    ],
    modelChanges: [
      { at: 1002, provider: "openai-codex", model: "gpt-6-astra" },
      { at: 90_000, provider: "deepseek", model: "deepseek-flash" },
    ],
  });
  const stats = decisionStats(session, { patterns: PATTERNS });
  assert.equal(stats.needless.length, 1);
  assert.equal(stats.needless[0].rating, 1.6);
});

test("a retreat long afterwards is not attributed to the escalation", () => {
  const session = sessionWith([], {
    entries: [
      {
        customType: "router-decision",
        at: 1000,
        data: { outcome: "escalated", difficulty: 2.4, to: "openai-codex/gpt-6-astra" },
      },
    ],
    modelChanges: [
      { at: 1002, provider: "openai-codex", model: "gpt-6-astra" },
      { at: 10_000_000, provider: "deepseek", model: "deepseek-flash" },
    ],
  });
  assert.equal(decisionStats(session, { patterns: PATTERNS }).needless.length, 0);
});

test("decisionStats tallies outcomes, ratings and latency", () => {
  const session = sessionWith([], {
    entries: [
      {
        customType: "router-decision",
        at: 1,
        data: { outcome: "held", difficulty: 0.4, latencyMs: 500 },
      },
      {
        customType: "router-decision",
        at: 2,
        data: { outcome: "escalated", difficulty: 2.1, latencyMs: 700 },
      },
      { customType: "router-decision", at: 3, data: { outcome: "judge-failed" } },
      { customType: "something-else", at: 4, data: { outcome: "ignored" } },
    ],
  });
  const stats = decisionStats(session, { patterns: PATTERNS });
  assert.equal(stats.decisions, 3);
  assert.deepEqual(stats.outcomes, { held: 1, escalated: 1, "judge-failed": 1 });
  assert.deepEqual(stats.ratings, [0.4, 2.1]);
  assert.equal(stats.latency.p50, 500);
});

test("ratingBuckets pairs each rating band with what actually followed", () => {
  const session = sessionWith([], {
    entries: [
      { customType: "router-decision", at: 1000, data: { outcome: "held", difficulty: 1.2 } },
      { customType: "router-decision", at: 2000, data: { outcome: "held", difficulty: 0.6 } },
      { customType: "router-decision", at: 3000, data: { outcome: "escalated", difficulty: 2.2 } },
    ],
    modelChanges: [{ at: 1100, provider: "openai-codex", model: "gpt-6-astra" }],
  });
  const buckets = ratingBuckets([session], { patterns: PATTERNS });
  const low = buckets.find((bucket) => bucket.label === "0–0.9");
  const mid = buckets.find((bucket) => bucket.label === "1.0–1.4");
  const high = buckets.find((bucket) => bucket.label === "2.0+");
  assert.equal(low.held, 1);
  assert.equal(mid.missed, 1, "held at 1.2 and then escalated by hand");
  assert.equal(high.escalated, 1);
});

test("percentile tolerates an empty set", () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([1, null, undefined, 3], 0.5), 1);
});

// ---------------------------------------------------------------------------
// Keeping the dial honest

test("thresholdPosition says where the threshold sits in the observed ratings", () => {
  const position = thresholdPosition([0.5, 1.0, 1.2, 2.0], 1.5);
  assert.equal(position.n, 4);
  assert.equal(position.below, 3);
  assert.equal(position.percentile, 0.75);
  assert.equal(thresholdPosition([], 1.5), null);
  // A threshold nothing clears is not routing, it is a fixed setting.
  assert.equal(thresholdPosition([0.2, 0.4], 1.5).percentile, 1);
});

test("a band is marked as too few until it has enough decisions", () => {
  const entries = Array.from({ length: MIN_BAND_SAMPLE }, (_, index) => ({
    customType: "router-decision",
    at: 1000 + index,
    data: { outcome: "held", difficulty: 0.5 },
  }));
  const [thin] = ratingBuckets([sessionWith([], { entries: entries.slice(0, 3) })], {
    patterns: PATTERNS,
  });
  const [enough] = ratingBuckets([sessionWith([], { entries })], { patterns: PATTERNS });
  assert.equal(thin.decisions, 3);
  assert.equal(thin.enoughData, false);
  assert.equal(enough.decisions, MIN_BAND_SAMPLE);
  assert.equal(enough.enoughData, true);
});
