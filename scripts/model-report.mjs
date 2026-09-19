// model-report.mjs — could turn features pick the model?
//
// The routing question is not "how do we save context" (context-report answers
// that) but "which turns actually needed the expensive model". This reads the
// corpus and reports three things:
//
//   1. What each model really costs per million context tokens — measured, not
//      quoted, so tiers come from this environment rather than a price list.
//   2. How premium-model turns differ from economy-model turns in features a
//      router can see: prompt size, hops, tool groups, failures.
//   3. What a deterministic feature-based chooser would have selected, and what
//      the corpus would have cost under it.
//
// The third is an estimate with two assumptions stated out loud: token counts
// are held as they were, and *quality is not measured at all*. A cheaper model
// that answers wrongly costs more than the expensive one that answered once.
//
//   node scripts/model-report.mjs [--json]

import path from "node:path";
import { homedir } from "node:os";

import { findSessionFiles, percentile, readSession } from "./lib/sessions.mjs";
import { looksInjected } from "../packages/router/lib.mjs";
import { chooseTier, featureVector, tierFor } from "../packages/router/model-tier.mjs";

const SESSIONS_DIR = path.join(homedir(), ".pi", "agent", "sessions");

function median(values) {
  return percentile(values, 0.5);
}

const files = findSessionFiles(SESSIONS_DIR);
const turns = [];
const byModel = new Map();
let injected = 0;
let injectedSpend = 0;

for (const file of files) {
  const session = readSession(file);
  let previousTurn = null;
  let stickyTier = null;
  let simpleStreak = 0;
  for (const turn of session.turns) {
    const price = { context: 0, cost: 0 };
    for (const request of turn.requests) {
      price.context += request.context;
      price.cost += request.cost.total > 0 ? request.cost.total : 0;
      const model = byModel.get(request.model) ?? {
        reqs: 0,
        context: 0,
        cost: 0,
        sessions: new Set(),
      };
      model.reqs++;
      model.context += request.context;
      model.cost += request.cost.total > 0 ? request.cost.total : 0;
      model.sessions.add(file);
      byModel.set(request.model, model);
    }
    if (!turn.requests.length) {
      previousTurn = turn;
      continue;
    }
    // Context dumps and agent messages are not typed prompts: they have no
    // request in them to route.
    if (looksInjected(turn.prompt)) {
      injected++;
      injectedSpend += turn.requests.reduce((n, r) => n + (r.cost.total > 0 ? r.cost.total : 0), 0);
      previousTurn = turn;
      continue;
    }
    turn.pricePerMillion = price.context ? (price.cost / price.context) * 1e6 : 0;
    turn.tier = tierFor(turn.pricePerMillion);
    turn.spend = price.cost;
    turn.contextRead = price.context;
    turn.features = featureVector(turn, previousTurn);
    // Two policies, because their difference is the finding. `free` decides
    // per turn with no memory; `sticky` holds an escalation until three
    // consecutive simple prompts have gone by. Neither can see the actual tier:
    // a chooser that can see the answer cannot estimate savings.
    turn.chosenFree = chooseTier(turn.features, null);
    turn.chosenSticky = chooseTier(turn.features, stickyTier);
    if (turn.chosenSticky.tier === "frontier") {
      stickyTier = "frontier";
      simpleStreak = 0;
    } else if (stickyTier === "frontier") {
      simpleStreak = turn.features.promptChars < 120 ? simpleStreak + 1 : 0;
      if (simpleStreak >= 3) stickyTier = turn.chosenSticky.tier;
    } else {
      stickyTier = turn.chosenSticky.tier;
    }
    turns.push(turn);
    previousTurn = turn;
  }
}

// Price each tier from the corpus, so the counterfactual uses this
// environment's rates rather than a published one.
const tierPrice = {};
for (const tier of ["frontier", "mid", "economy"]) {
  const meters = [...byModel.entries()]
    .map(([model, a]) => ({ model, ...a, perMillion: a.context ? (a.cost / a.context) * 1e6 : 0 }))
    .filter((entry) => tierFor(entry.perMillion) === tier && entry.context > 0 && entry.cost > 0);
  const context = meters.reduce((n, entry) => n + entry.context, 0);
  const cost = meters.reduce((n, entry) => n + entry.cost, 0);
  tierPrice[tier] = context ? (cost / context) * 1e6 : 0;
}

const actual = turns.reduce((n, turn) => n + turn.spend, 0);
const spendUnder = (policy) =>
  turns.reduce((n, turn) => n + (turn.contextRead * tierPrice[turn[policy].tier]) / 1e6, 0);
const simulatedFree = spendUnder("chosenFree");
const simulatedSticky = spendUnder("chosenSticky");

const tierStats = {};
for (const tier of ["frontier", "mid", "economy"]) {
  const rows = turns.filter((turn) => turn.tier === tier);
  tierStats[tier] = {
    turns: rows.length,
    spend: rows.reduce((n, turn) => n + turn.spend, 0),
    context: rows.reduce((n, turn) => n + turn.contextRead, 0),
    perMillion: tierPrice[tier],
    promptChars: median(rows.map((turn) => turn.features.promptChars)),
    hops: median(rows.map((turn) => turn.features.hops)),
    groups: median(rows.map((turn) => turn.features.groups)),
    failures: median(rows.map((turn) => turn.features.failures)),
    markers: rows.filter((turn) => turn.features.marker).length / (rows.length || 1),
    conversational: rows.filter((turn) => turn.features.conversational).length / (rows.length || 1),
  };
}

// Confusion between the model that actually served a turn and the one the
// rules would have picked.
const confusion = {};
for (const actualTier of ["frontier", "mid", "economy"]) {
  for (const chosenTier of ["frontier", "mid", "economy"]) {
    confusion[`${actualTier}->${chosenTier}`] = turns.filter(
      (turn) => turn.tier === actualTier && turn.chosenFree.tier === chosenTier,
    ).length;
  }
}

const frontierTurns = turns.filter((turn) => turn.tier === "frontier");
const downgradedUnder = (policy) =>
  turns.filter((turn) => turn.tier === "frontier" && turn[policy].tier !== "frontier");
const downgradedFree = downgradedUnder("chosenFree");
const downgradedSticky = downgradedUnder("chosenSticky");
const spendOf = (rows) => rows.reduce((n, turn) => n + turn.spend, 0);

const report = {
  corpus: {
    sessions: files.length,
    turns: turns.length,
    injectedExcluded: injected,
    injectedSpend,
    actualSpend: actual,
    simulatedFree,
    simulatedSticky,
  },
  models: [...byModel.entries()]
    .map(([model, a]) => ({
      model,
      reqs: a.reqs,
      sessions: a.sessions.size,
      context: a.context,
      cost: a.cost,
      perMillion: a.context ? (a.cost / a.context) * 1e6 : 0,
      tier: tierFor(a.context ? (a.cost / a.context) * 1e6 : 0),
    }))
    .sort((a, b) => b.cost - a.cost),
  tiers: tierStats,
  confusion,
  downgraded: {
    free: { turns: downgradedFree.length, spend: spendOf(downgradedFree) },
    sticky: { turns: downgradedSticky.length, spend: spendOf(downgradedSticky) },
    frontierTurns: frontierTurns.length,
    frontierSpend: spendOf(frontierTurns),
  },
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const money = (x) => `$${x.toFixed(2)}`;
  const pct = (x) => `${(100 * x).toFixed(0)}%`;

  console.log(`corpus: ${report.corpus.sessions} sessions · ${turns.length} routable turns`);
  if (injected)
    console.log(
      `   excluded ${injected} injected turn(s) — context dumps and agent messages, not routed prompts`,
    );
  console.log(
    `   spend on routable turns ${money(actual)} (injected turns, omitted above, add ${money(report.corpus.injectedSpend)})`,
  );
  console.log(
    `   the counterfactual below prices these turns only, and it holds token counts fixed — a real mid-conversation switch also cold-starts the prompt cache, which the corpus shows is 98.6% of what gets re-read\n`,
  );

  console.log("what each tier costs here (measured $/M context tokens)");
  for (const [tier, stats] of Object.entries(tierStats)) {
    console.log(
      `   ${tier.padEnd(9)} ${money(stats.perMillion).padStart(8)}/M   ${String(stats.turns).padStart(4)} turns   ${money(stats.spend).padStart(8)}   (${pct(stats.turns / turns.length)} of turns, ${pct(stats.spend / actual)} of spend)`,
    );
  }

  console.log(
    "\nwhat the turns on each tier look like (features marked * are hindsight, not routable)",
  );
  console.log("   tier       prompt chars   hops*  groups*  failures*  markers  conversational");
  for (const [tier, stats] of Object.entries(tierStats)) {
    console.log(
      `   ${tier.padEnd(9)} ${String(stats.promptChars).padStart(9)}   ${String(stats.hops).padStart(5)}   ${String(stats.groups).padStart(5)}   ${String(stats.failures).padStart(7)}   ${pct(stats.markers).padStart(6)}   ${pct(stats.conversational).padStart(12)}`,
    );
  }

  console.log("\nmodel choice, actual → chosen by the rules");
  for (const actualTier of ["frontier", "mid", "economy"]) {
    const parts = ["frontier", "mid", "economy"].map(
      (tier) => `${tier} ${confusion[`${actualTier}->${tier}`]}`,
    );
    console.log(`   ${actualTier.padEnd(9)} → ${parts.join(" · ")}`);
  }

  console.log(`\ncounterfactual (token counts held, quality not measured)`);
  console.log(`   actual spend                ${money(actual)}`);
  const delta = (value) =>
    `${value < actual ? "-" : "+"}${pct(Math.abs(value - actual) / (actual || 1))}`;
  console.log(`   per-turn chooser            ${money(simulatedFree)}   (${delta(simulatedFree)})`);
  console.log(
    `   sticky chooser (3-turn decay) ${money(simulatedSticky)}   (${delta(simulatedSticky)})`,
  );
  console.log(
    `   frontier turns downgraded: free ${downgradedFree.length} carrying ${money(spendOf(downgradedFree))} · sticky ${downgradedSticky.length} carrying ${money(spendOf(downgradedSticky))}  (of ${frontierTurns.length} frontier turns, ${money(spendOf(frontierTurns))})`,
  );

  const examples = downgradedFree
    .filter((turn) => turn.spend > 0)
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 10);
  if (examples.length) {
    console.log(
      "\n   the prompts those downgrades would have moved off a frontier model (read these, not the totals):",
    );
    for (const turn of examples) {
      console.log(
        `     ${money(turn.spend).padStart(7)} → ${turn.chosenFree.tier.padEnd(8)} ${turn.prompt.replace(/\s+/g, " ").slice(0, 110)}`,
      );
    }
  }

  console.log("\ntier features that a router can actually see");
  for (const tier of ["frontier", "mid", "economy"]) {
    const rows = turns.filter((turn) => turn.tier === tier);
    const chars = rows.map((turn) => turn.features.promptChars);
    console.log(
      `   ${tier.padEnd(9)} prompt chars p50 ${String(median(chars)).padStart(4)} · p90 ${String(percentile(chars, 0.9)).padStart(5)} · markers ${pct(rows.filter((t) => t.features.marker).length / (rows.length || 1))}`,
    );
  }

  console.log("\nbiggest models by spend");
  for (const model of report.models.slice(0, 8)) {
    console.log(
      `   ${model.model.padEnd(38)} ${model.tier.padEnd(8)} ${money(model.perMillion).padStart(8)}/M  ${String(model.reqs).padStart(5)} reqs in ${String(model.sessions).padStart(3)} sessions  ${money(model.cost).padStart(8)}`,
    );
  }
}
