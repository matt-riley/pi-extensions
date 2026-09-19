// router-report.mjs — what the router costs, and how its decisions are landing.
//
// Reads pi's session transcripts plus the router's own decision entries and
// reports three things:
//
//   1. What a model switch actually costs: cold tokens, the dollars paid at the
//      switch, and how many requests until the destination is warm again.
//   2. What frontier episodes cost against the same session's cheaper model.
//   3. How decisions are landing in live use — held judgements the user then
//      escalated by hand (misses), escalations the user retreated from
//      (needless), and the rating each of them carried.
//
//   node scripts/router-report.mjs [--json]
//
// Estimates are labelled as estimates. Quality is not measured anywhere here: a
// cheaper answer is not scored against an expensive one.

import path from "node:path";
import { homedir } from "node:os";

import {
  decisionStats,
  frontierEpisodes,
  MIN_BAND_SAMPLE,
  percentile,
  ratingBuckets,
  switchCosts,
  thresholdPosition,
} from "../packages/router/metrics.mjs";
import { DEFAULT_FRONTIER_PATTERNS } from "../packages/router/model-battery.mjs";
import { findSessionFiles, readSession } from "./lib/sessions.mjs";

const SESSIONS_DIR = path.join(homedir(), ".pi", "agent", "sessions");
const PATTERNS = process.env.PI_ROUTER_FRONTIER
  ? process.env.PI_ROUTER_FRONTIER.split(",")
      .map((part) => part.trim())
      .filter(Boolean)
  : DEFAULT_FRONTIER_PATTERNS;

function main() {
  const sessions = findSessionFiles(SESSIONS_DIR).map((file) => readSession(file));

  const switches = [];
  const episodes = [];
  let decisions = 0;
  let missed = 0;
  let needless = 0;
  const ratings = [];
  const latencies = [];

  for (const session of sessions) {
    switches.push(
      ...switchCosts(
        session.turns
          .flatMap((turn) => turn.requests ?? [])
          .map((request) => ({
            model: request.model,
            context: request.context,
            freshInput: request.input,
            cacheRead: request.cacheRead,
            cacheWrite: request.cacheWrite,
            output: request.output,
            cost: request.cost?.total ?? 0,
            prompt: null,
            failures: 0,
          })),
      ),
    );

    episodes.push(...frontierEpisodes(session, { patterns: PATTERNS }));

    const stats = decisionStats(session, { patterns: PATTERNS });
    decisions += stats.decisions;
    missed += stats.missed.length;
    needless += stats.needless.length;
    ratings.push(...stats.ratings);
    for (const decision of session.entries ?? []) {
      if (decision.customType === "router-decision" && Number.isFinite(decision.data?.latencyMs)) {
        latencies.push(decision.data.latencyMs);
      }
    }
  }

  // The same measurement outside episodes, so "39% of turns failed" means
  // something: if frontier turns fail more, the escalation is finding hard work.
  let allTurns = 0;
  let allTurnsWithFailures = 0;
  for (const session of sessions) {
    for (const turn of session.turns ?? []) {
      if (!(turn.requests ?? []).length) continue;
      allTurns++;
      if ((turn.toolCalls ?? []).some((call) => call.isError)) allTurnsWithFailures++;
    }
  }

  const withRewarm = switches.filter((entry) => entry.rewarmRequests !== null);
  const money = (value) => `$${(value ?? 0).toFixed(4)}`;
  const num = (value) => (value === null ? "–" : Math.round(value).toLocaleString());
  const pct = (value) => (value === null ? "–" : `${(100 * value).toFixed(0)}%`);

  const report = {
    corpus: { sessions: sessions.length },
    switches: {
      count: switches.length,
      coldTokens: percentile(
        switches.map((entry) => entry.coldTokens),
        0.5,
      ),
      coldCost: percentile(
        switches.map((entry) => entry.coldCost),
        0.5,
      ),
      rewarmRequests: percentile(
        withRewarm.map((entry) => entry.rewarmRequests),
        0.5,
      ),
      neverRewarmed: switches.length - withRewarm.length,
    },
    episodes: {
      count: episodes.length,
      requests: episodes.reduce((n, episode) => n + episode.requests, 0),
      cost: episodes.reduce((n, episode) => n + episode.cost, 0),
      perRequest: percentile(
        episodes.map((episode) => episode.perRequest),
        0.5,
      ),
      baselinePerRequest: percentile(
        episodes.map((episode) => episode.baselinePerRequest).filter(Number.isFinite),
        0.5,
      ),
      extraCost: episodes.reduce((n, episode) => n + (episode.extraCost ?? 0), 0),
      // Failures belong to turns, not requests: a request inherits its turn.
      failureShare: percentile(
        episodes.map((episode) => episode.failureShare).filter(Number.isFinite),
        0.5,
      ),
      episodeTurns: episodes.reduce((n, episode) => n + episode.turns, 0),
      cacheShare: percentile(
        episodes.map((episode) => episode.cacheShare).filter(Number.isFinite),
        0.5,
      ),
      episodeRequests: {
        p50: percentile(
          episodes.map((episode) => episode.requests),
          0.5,
        ),
        p90: percentile(
          episodes.map((episode) => episode.requests),
          0.9,
        ),
      },
      corpusTurns: allTurns,
      corpusFailureRate: allTurns ? allTurnsWithFailures / allTurns : 0,
      turns: episodes.reduce((n, episode) => n + episode.turns, 0),
    },
    decisions: {
      count: decisions,
      missed,
      needless,
      rating: { p50: percentile(ratings, 0.5), p90: percentile(ratings, 0.9) },
      latency: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
      buckets: ratingBuckets(sessions, { patterns: PATTERNS }),
      // Where the dial sits in the observed ratings: the cheapest check that it
      // is doing anything at all.
      thresholdPosition: thresholdPosition(ratings, Number(process.env.PI_ROUTER_THRESHOLD ?? 1.5)),
    },
  };

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`corpus: ${sessions.length} sessions\n`);

  console.log("what a model switch costs (every switch in the corpus, router or not)");
  console.log(`   switches                 ${report.switches.count}`);
  console.log(`   cold tokens at switch    p50 ${num(report.switches.coldTokens)}`);
  console.log(`   dollars paid at switch   p50 ${money(report.switches.coldCost)}`);
  console.log(
    `   requests to rewarm       p50 ${num(report.switches.rewarmRequests)}${report.switches.neverRewarmed ? `   (${report.switches.neverRewarmed} never rewarmed)` : ""}`,
  );
  console.log(
    "   read this as: a switch pays full price for the whole prefix again, then\n   climbs back to cache rates over the next request or two.\n",
  );

  console.log("frontier episodes (a contiguous run on a frontier model)");
  console.log(
    `   episodes                 ${report.episodes.count} covering ${num(report.episodes.requests)} requests`,
  );
  console.log(`   cost                     $${report.episodes.cost.toFixed(2)}`);
  console.log(
    `   cost per request         p50 ${money(report.episodes.perRequest)}   baseline for the same sessions ${money(report.episodes.baselinePerRequest)}`,
  );
  console.log(
    `   estimated extra cost     $${report.episodes.extraCost.toFixed(2)}   (same tokens at the session's cheaper rate; quality not compared)`,
  );
  console.log(
    `   episode length            p50 ${report.episodes.episodeRequests.p50} requests, p90 ${report.episodes.episodeRequests.p90}`,
  );
  console.log(`   cache share inside        p50 ${pct(report.episodes.cacheShare)}`);
  console.log(
    `   turns with a failure      ${pct(report.episodes.failureShare)} inside episodes vs ${pct(report.episodes.corpusFailureRate)} across all ${num(report.episodes.corpusTurns)} turns`,
  );
  console.log("   (a failed tool call measures churn, not difficulty: routine");
  console.log(
    "    test-fail-edit loops fail more often and they run on the cheap model,\n    so this is not a quality signal in either direction.)\n",
  );

  console.log("router decisions");
  console.log(`   judgements               ${report.decisions.count}`);
  console.log(
    `   rating                   p50 ${report.decisions.rating.p50 ?? "–"}   p90 ${report.decisions.rating.p90 ?? "–"}`,
  );
  console.log(
    `   judge latency            p50 ${num(report.decisions.latency.p50)}ms   p95 ${num(report.decisions.latency.p95)}ms`,
  );
  console.log(
    `   missed escalations       ${report.decisions.missed}   (held, then you escalated by hand)`,
  );
  console.log(
    `   needless escalations     ${report.decisions.needless}   (escalated, then you retreated)`,
  );
  if (report.decisions.count) {
    const position = report.decisions.thresholdPosition;
    if (position) {
      console.log(
        `\n   the threshold sits above ${pct(position.percentile)} of ${num(position.n)} observed ratings` +
          (position.percentile < 0.1
            ? "  <- escalates almost everything"
            : position.percentile > 0.95
              ? "  <- escalates almost nothing"
              : ""),
      );
    }
    console.log("\n   rating band   n   escalated   held   missed   needless");
    for (const bucket of report.decisions.buckets) {
      console.log(
        `   ${bucket.label.padEnd(12)} ${String(bucket.decisions).padStart(2)} ${String(bucket.escalated).padStart(10)} ${String(bucket.held).padStart(6)} ${String(bucket.missed).padStart(8)} ${String(bucket.needless).padStart(10)}` +
          (bucket.enoughData ? "" : "   (too few)"),
      );
    }
    console.log("\n   How to read it - the only tuning rule this report supports:");
    console.log("     misses in a band, none needless  -> lower the threshold into it");
    console.log("     needless in a band               -> raise the threshold above it");
    console.log(
      `     under ${MIN_BAND_SAMPLE} judgements in a band, change nothing: the band is noise.`,
    );
  } else {
    console.log(
      "\n   No decisions recorded yet — the entries land as `router-decision` custom\n   records once the router runs in a session started after it loaded.",
    );
  }
}

main();
