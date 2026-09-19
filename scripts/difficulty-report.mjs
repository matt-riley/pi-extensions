// difficulty-report.mjs — can Jev spot the turns that needed a frontier model?
//
// The deterministic rules scored 30% recall at 7% precision on this corpus: on
// the turns that mattered most they were not merely unhelpful, they were
// confidently wrong (see model-report.mjs). This asks TypeSafe the question the
// rules could not answer, using only state a router would have before the turn
// runs:
//
//   - the prompt
//   - the last few turns of the conversation: what was asked, what the
//     assistant answered, whether commands were failing, what tools ran
//   - the working directory
//
// Deliberately absent: the model that actually served the turn, its cost, its
// token count, and anything else that would be reading the answer. The label
// comes from measured spend per million tokens, so "frontier" is a price here,
// not an opinion.
//
//   node scripts/difficulty-report.mjs [--limit 50] [--json]

import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

import { askSystemOne } from "../shared/systemone.mjs";
import { looksInjected } from "../packages/router/lib.mjs";
import { tierFor } from "../packages/router/model-tier.mjs";
import {
  buildDifficultyState as buildState,
  buildQuestions as modelQuestions,
} from "../packages/router/model-battery.mjs";
import { findSessionFiles, percentile, readSession } from "./lib/sessions.mjs";

const SESSIONS_DIR = path.join(homedir(), ".pi", "agent", "sessions");
const WINDOW = 4;

function parseArgs(argv) {
  const opts = { limit: 50, json: false, cache: "/tmp/difficulty-report.json", fromCache: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") opts.json = true;
    else if (argv[i] === "--from-cache") opts.fromCache = true;
    else if (argv[i] === "--cache") opts.cache = argv[++i];
    else if (argv[i] === "--limit") opts.limit = Number(argv[++i]) || 50;
  }
  return opts;
}

/** Mann-Whitney AUC: how well a score separates two classes. */
function auc(positives, negatives) {
  if (!positives.length || !negatives.length) return null;
  const all = [
    ...positives.map((value) => ({ value, y: 1 })),
    ...negatives.map((value) => ({ value, y: 0 })),
  ];
  all.sort((a, b) => a.value - b.value);
  let rank = 0;
  const ranks = new Map();
  for (let i = 0; i < all.length;) {
    let j = i;
    while (j + 1 < all.length && all[j + 1].value === all[i].value) j++;
    const average = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) ranks.set(k, average);
    i = j + 1;
  }
  for (let i = 0; i < all.length; i++) if (all[i].y === 1) rank += ranks.get(i);
  const n1 = positives.length;
  const n0 = negatives.length;
  return (rank - (n1 * (n1 + 1)) / 2) / (n1 * n0);
}

function sweep(rows, key, thresholds, tierPrice) {
  const out = [];
  for (const threshold of thresholds) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    // Escalating a turn costs the difference between frontier rates and
    // whatever tier it actually ran on; skipping one keeps its real cost.
    let wrongEscalationCost = 0;
    let missedFrontierSpend = 0;
    for (const row of rows) {
      const predicted = row[key] >= threshold;
      const asFrontier = (row.context * tierPrice.frontier) / 1e6;
      if (row.frontier && predicted) tp++;
      else if (row.frontier) {
        fn++;
        missedFrontierSpend += row.spend;
      } else if (predicted) {
        fp++;
        wrongEscalationCost += Math.max(0, asFrontier - row.spend);
      }
    }
    out.push({
      threshold,
      tp,
      fp,
      fn,
      precision: tp + fp ? tp / (tp + fp) : null,
      recall: tp + fn ? tp / (tp + fn) : null,
      wrongEscalationCost,
      missedFrontierSpend,
    });
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  const frontier = [];
  const other = [];
  const sessions = new Map();

  for (const file of findSessionFiles(SESSIONS_DIR)) {
    const session = readSession(file);
    let window = [];
    for (const turn of session.turns) {
      if (!turn.requests.length || looksInjected(turn.prompt)) {
        window = [...window, turn].slice(-WINDOW);
        continue;
      }
      const spend = turn.requests.reduce((n, r) => n + (r.cost.total > 0 ? r.cost.total : 0), 0);
      const context = turn.requests.reduce((n, r) => n + r.context, 0);
      const pricePerMillion = context ? (spend / context) * 1e6 : 0;
      const row = {
        file: path.basename(file),
        prompt: turn.prompt,
        spend,
        context,
        tier: tierFor(pricePerMillion),
        frontier: tierFor(pricePerMillion) === "frontier",
        window: [...window],
        cwd: turn.cwd,
      };
      (row.frontier ? frontier : other).push(row);
      if (!sessions.has(file)) sessions.set(file, { got: 0, total: 0, frontier: false });
      sessions.get(file).total++;
      if (row.frontier) sessions.get(file).frontier = true;
      window = [...window, turn].slice(-WINDOW);
    }
  }

  // Deterministic spread over the non-frontier turns, so runs stay comparable.
  const step = Math.max(1, Math.floor(other.length / opts.limit));
  const sampledOther = other.filter((_, index) => index % step === 0).slice(0, opts.limit);
  const sample = [...frontier, ...sampledOther];

  console.log(
    `corpus: ${frontier.length} frontier turns ($${frontier.reduce((n, r) => n + r.spend, 0).toFixed(2)}) · ${other.length} others`,
  );

  const rows = [];
  let index = 0;
  const cached =
    opts.fromCache && fs.existsSync(opts.cache)
      ? JSON.parse(fs.readFileSync(opts.cache, "utf8"))
      : null;
  if (cached) {
    console.log(`reusing ${cached.length} cached judgements from ${opts.cache} (no calls)\n`);
    rows.push(...cached);
  } else {
    for (const row of sample) {
      index++;
      process.stderr.write(`\r  judging ${index}/${sample.length}`);
      try {
        const result = await askSystemOne({
          state: buildState(row.prompt, row.window, row.cwd),
          questions: modelQuestions(),
        });
        const difficulty = Number(result?.answers?.difficulty?.score);
        const needs = Number(result?.answers?.needs_frontier?.noul);
        rows.push({
          ...row,
          window: undefined,
          difficulty: Number.isFinite(difficulty) ? difficulty : null,
          needs: Number.isFinite(needs) ? needs : null,
        });
      } catch (error) {
        process.stderr.write(`\n  failed: ${error instanceof Error ? error.message : error}\n`);
      }
    }
    process.stderr.write("\n");
    fs.writeFileSync(opts.cache, JSON.stringify(rows, null, 1));
  }

  // Price each tier from the corpus, for the escalation arithmetic below.
  const tierPrice = {};
  {
    const meters = new Map();
    for (const row of [...frontier, ...other]) {
      const entry = meters.get(row.tier) ?? { context: 0, cost: 0 };
      entry.context += row.context;
      entry.cost += row.spend;
      meters.set(row.tier, entry);
    }
    for (const [tier, entry] of meters)
      tierPrice[tier] = entry.context ? (entry.cost / entry.context) * 1e6 : 0;
  }

  const scored = rows.filter((row) => row.needs !== null && row.difficulty !== null);
  const pos = scored.filter((row) => row.frontier);
  const neg = scored.filter((row) => !row.frontier);
  const report = {
    judged: scored.length,
    frontierTurns: pos.length,
    otherTurns: neg.length,
    spread: {
      difficulty: {
        frontier: percentile(
          pos.map((row) => row.difficulty),
          0.5,
        ),
        other: percentile(
          neg.map((row) => row.difficulty),
          0.5,
        ),
        auc: auc(
          pos.map((row) => row.difficulty),
          neg.map((row) => row.difficulty),
        ),
      },
      needs: {
        frontier: percentile(
          pos.map((row) => row.needs),
          0.5,
        ),
        other: percentile(
          neg.map((row) => row.needs),
          0.5,
        ),
        auc: auc(
          pos.map((row) => row.needs),
          neg.map((row) => row.needs),
        ),
      },
    },
    sweep: sweep(scored, "needs", [0.3, 0.5, 0.6, 0.7, 0.8, 0.9], tierPrice),
    difficultySweep: sweep(scored, "difficulty", [1, 1.5, 2, 2.5], tierPrice),
    sessionLevel: null,
  };

  // The design says routing belongs at task boundaries, so the decision that
  // matters is per session: escalate if any turn in it looked frontier-worthy.
  const bySession = new Map();
  for (const row of scored) {
    const entry = bySession.get(row.file) ?? { frontier: false, maxNeeds: 0, turns: 0 };
    entry.frontier ||= row.frontier;
    entry.maxNeeds = Math.max(entry.maxNeeds, row.needs);
    entry.turns++;
    bySession.set(row.file, entry);
  }
  let sTp = 0;
  let sFp = 0;
  let sFn = 0;
  for (const entry of bySession.values()) {
    const predicted = entry.maxNeeds >= 0.5;
    if (entry.frontier && predicted) sTp++;
    else if (entry.frontier) sFn++;
    else if (predicted) sFp++;
  }
  report.sessionLevel = {
    sessions: bySession.size,
    tp: sTp,
    fp: sFp,
    fn: sFn,
    precision: sTp + sFp ? sTp / (sTp + sFp) : null,
    recall: sTp + sFn ? sTp / (sTp + sFn) : null,
  };

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const pct = (x) => (x === null || x === undefined ? "  –  " : `${(100 * x).toFixed(0)}%`);
  console.log(
    `judged ${report.judged} (${report.frontierTurns} frontier, ${report.otherTurns} other)\n`,
  );
  console.log("separation");
  console.log(
    `   difficulty score  frontier p50 ${report.spread.difficulty.frontier}  other p50 ${report.spread.difficulty.other}   AUC ${report.spread.difficulty.auc?.toFixed(2) ?? "–"}`,
  );
  console.log(
    `   needs_frontier    frontier p50 ${report.spread.needs.frontier?.toFixed(2)}  other p50 ${report.spread.needs.other?.toFixed(2)}   AUC ${report.spread.needs.auc?.toFixed(2) ?? "–"}`,
  );

  console.log("\nthreshold sweep on needs_frontier (frontier = positive)");
  console.log(
    "   thresh   precision   recall   tp  fp  fn   cost of wrong escalations   frontier spend skipped",
  );
  for (const row of report.sweep) {
    console.log(
      `   ${row.threshold.toFixed(2)}     ${pct(row.precision)}       ${pct(row.recall)}   ${String(row.tp).padStart(2)}  ${String(row.fp).padStart(2)}  ${String(row.fn).padStart(2)}   ${("$" + row.wrongEscalationCost.toFixed(2)).padStart(20)}   ${("$" + row.missedFrontierSpend.toFixed(2)).padStart(18)}`,
    );
  }

  console.log("\nthreshold sweep on the difficulty score (same rows, better instrument)");
  console.log(
    "   score    precision   recall   tp  fp  fn   cost of wrong escalations   frontier spend skipped",
  );
  for (const row of report.difficultySweep) {
    console.log(
      `   ${row.threshold.toFixed(1)}      ${pct(row.precision)}       ${pct(row.recall)}   ${String(row.tp).padStart(2)}  ${String(row.fp).padStart(2)}  ${String(row.fn).padStart(2)}   ${("$" + row.wrongEscalationCost.toFixed(2)).padStart(20)}   ${("$" + row.missedFrontierSpend.toFixed(2)).padStart(18)}`,
    );
  }

  const session = report.sessionLevel;
  console.log(
    `\nper session (escalate if any turn looks frontier-worthy): ${session.sessions} sessions`,
  );
  console.log(
    `   precision ${pct(session.precision)}   recall ${pct(session.recall)}   (tp ${session.tp} · fp ${session.fp} · fn ${session.fn})`,
  );
  console.log(
    "   read this one loosely: only a sample of each session's turns was judged, so a session's",
  );
  console.log(
    "   maximum is a maximum over the sample. The turn-level rows below are the real evidence.",
  );

  console.log(
    "\nthe label is a floor, not a ceiling: 'frontier' means the turn actually ran on a frontier",
  );
  console.log(
    "model, and model choice in this corpus was mostly per session. A turn called hard inside an",
  );
  console.log(
    "economy session is counted against precision here even if it would have benefited — so the",
  );
  console.log("precision above understates what the judgement gets right.");

  const interesting = pos
    .filter((row) => row.spend > 0)
    .sort((a, b) => b.spend - a.spend)
    .slice(0, 12);
  console.log("\nseparated by what the turn cost, not by whether it was right:");
  for (const row of interesting) {
    const flag = row.needs >= 0.5 ? "caught" : "MISSED";
    console.log(
      `   ${flag}  ${row.difficulty}/3 · ${row.needs.toFixed(2)} · $${row.spend.toFixed(2)}  ${row.prompt.replace(/\s+/g, " ").slice(0, 96)}`,
    );
  }

  const falsePositives = neg
    .filter((row) => row.needs >= 0.8)
    .sort((a, b) => b.needs - a.needs)
    .slice(0, 6);
  if (falsePositives.length) {
    console.log("\nnon-frontier turns Jev would have escalated (the cost of the signal)");
    for (const row of falsePositives) {
      console.log(
        `   ${row.difficulty}/3 · ${row.needs.toFixed(2)}  ${row.prompt.replace(/\s+/g, " ").slice(0, 96)}`,
      );
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
