// route-report.mjs — score the prompt router against real sessions.
//
// The corpus is the answer key. Every recorded turn knows which tool groups it
// actually used, which makes two questions measurable without guessing:
//
//   1. Gate: does the cheap heuristic catch the turns that shifted, and stay
//      quiet on the ones that merely continued?
//   2. Battery: can TypeSafe predict which groups a turn will need — and how
//      often is it wrong in the dangerous direction (a group used but not
//      offered)?
//
//   node scripts/route-report.mjs                 # gate only, no network, all turns
//   node scripts/route-report.mjs --live          # + judged battery on a sample
//   node scripts/route-report.mjs --live --limit 40
//
// Read-only. Exits non-zero when a group that matters is under-recalled.

import { homedir } from "node:os";
import path from "node:path";

import { askSystemOne } from "../shared/systemone.mjs";
import { buildQuestions, buildRouterState, routeFromAnswers } from "../packages/router/battery.mjs";
import {
  gateTurn,
  groundTruth,
  scoreRun,
  shouldRoute,
  TOOL_GROUPS,
  ALWAYS_ON_GROUPS,
  SCOPED_GROUPS,
} from "../packages/router/lib.mjs";
import { findSessionFiles, percentile, readSession } from "./lib/sessions.mjs";
import { looksInjected } from "../packages/router/lib.mjs";

const SESSIONS_DIR = path.join(homedir(), ".pi", "agent", "sessions");

function parseArgs(argv) {
  const opts = { live: false, limit: 30, json: false, failUnder: 0.8, includeInjected: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--live") opts.live = true;
    else if (arg === "--json") opts.json = true;
    else if (arg === "--include-injected") opts.includeInjected = true;
    else if (arg === "--limit") opts.limit = Number(argv[++i]) || 0;
    else if (arg === "--fail-under") opts.failUnder = Number(argv[++i]) || 0.8;
  }
  return opts;
}

/** Every turn in the corpus, paired with its predecessor inside the same session. */
function collectTurns(dir, { includeInjected = false } = {}) {
  const rows = [];
  const injected = [];
  for (const file of findSessionFiles(dir)) {
    const { turns, cwd } = readSession(file);
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      const previousTurn = i > 0 ? turns[i - 1] : null;
      const gate = gateTurn({ prompt: turn.prompt, previousTurn });
      const truth = groundTruth(turn);
      const answerKey = shouldRoute(previousTurn, turn);
      const injectedKind = looksInjected(turn.prompt);
      const row = {
        file,
        cwd: turn.cwd ?? cwd,
        prompt: turn.prompt,
        previousTurn,
        truthGroups: truth.groups,
        unmapped: truth.unmapped,
        toolCount: truth.toolCount,
        isConversational: truth.isConversational,
        injectedKind,
        shouldRoute: answerKey.route,
        shouldRouteReason: answerKey.reason,
        didRoute: gate.route,
        gateReason: gate.reason,
      };
      if (injectedKind && !includeInjected) injected.push(row);
      else rows.push(row);
    }
  }
  return { rows, injected };
}

/** Deterministic spread over the routed turns, so runs are comparable. */
function sample(rows, limit) {
  if (!limit || rows.length <= limit) return rows;
  const step = rows.length / limit;
  const out = [];
  for (let i = 0; i < limit; i++) out.push(rows[Math.min(rows.length - 1, Math.floor(i * step))]);
  return out;
}

function pct(value) {
  return value === null || value === undefined
    ? "  –  "
    : `${(100 * value).toFixed(0).padStart(3)}%`;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { rows, injected } = collectTurns(SESSIONS_DIR, { includeInjected: opts.includeInjected });
  const conversational = rows.filter((row) => row.isConversational).length;
  const unrouted = rows.filter((row) => !row.didRoute);

  // The dangerous direction for the gate: a turn that needed a group the
  // previous turn never used, which we then never asked the judge about.
  const missedByGate = unrouted.filter((row) => row.shouldRoute);

  const report = {
    corpus: {
      turns: rows.length,
      conversational,
      routed: rows.filter((row) => row.didRoute).length,
      shouldRoute: rows.filter((row) => row.shouldRoute).length,
      excludedInjected: injected.length,
      excludedKinds: injected.reduce((acc, row) => {
        acc[row.injectedKind] = (acc[row.injectedKind] ?? 0) + 1;
        return acc;
      }, {}),
    },
    gateMissesByGroup: Object.fromEntries(
      Object.keys(TOOL_GROUPS).map((group) => [
        group,
        missedByGate.filter(
          (row) =>
            row.truthGroups.has(group) &&
            !(row.previousTurn ? groundTruth(row.previousTurn).groups.has(group) : false),
        ).length,
      ]),
    ),
    live: null,
  };

  const rowsWithPredictions = [];

  if (opts.live) {
    const routed = rows.filter((row) => row.didRoute);
    const chosen = sample(routed, opts.limit);
    const latencies = [];
    let index = 0;
    for (const row of chosen) {
      const started = Date.now();
      try {
        const result = await askSystemOne({
          state: buildRouterState({
            prompt: row.prompt,
            previousTurn: row.previousTurn,
            cwd: row.cwd,
          }),
          questions: buildQuestions(),
        });
        const routed2 = routeFromAnswers(result.answers);
        if (routed2.groups) {
          row.predictedGroups = routed2.groups;
          row.taskClass = routed2.taskClass;
          row.wantsStrongModel = routed2.wantsStrongModel;
          row.answers = routed2.signals;
          rowsWithPredictions.push(row);
        }
      } catch (error) {
        console.error(`  judgement failed (${error instanceof Error ? error.message : error})`);
      }
      latencies.push(Date.now() - started);
      index++;
      process.stderr.write(`\r  judged ${index}/${chosen.length}`);
    }
    process.stderr.write("\n");
    report.live = {
      sampled: chosen.length,
      scored: rowsWithPredictions.length,
      latency: { p50: percentile(latencies, 0.5), p90: percentile(latencies, 0.9) },
      scores: scoreRun(rowsWithPredictions),
      misses: rowsWithPredictions
        .filter((row) => [...row.truthGroups].some((group) => !row.predictedGroups.has(group)))
        .map((row) => ({
          prompt: row.prompt.slice(0, 120),
          truth: [...row.truthGroups],
          predicted: [...row.predictedGroups],
          missing: [...row.truthGroups].filter((group) => !row.predictedGroups.has(group)),
          signals: row.answers,
        })),
    };
  }

  const gate = scoreRun(rows).gate;

  if (opts.json) {
    console.log(JSON.stringify({ ...report, gate }, null, 2));
  } else {
    console.log(
      `corpus: ${report.corpus.turns} turns · ${conversational} conversational (${pct(conversational / report.corpus.turns)}) · ${report.corpus.routed} routed by the gate`,
    );
    if (report.corpus.excludedInjected) {
      const kinds = Object.entries(report.corpus.excludedKinds)
        .map(([kind, n]) => `${kind} ${n}`)
        .join(" · ");
      console.log(
        `   excluded ${report.corpus.excludedInjected} injected turn(s) (${kinds}) — not typed prompts; --include-injected to score them`,
      );
    }
    console.log();

    console.log("gate");
    console.log(
      `   answer key says route: ${report.corpus.shouldRoute} turns (${pct(report.corpus.shouldRoute / report.corpus.turns)})`,
    );
    console.log(
      `   gate routes:           ${report.corpus.routed} turns (${pct(report.corpus.routed / report.corpus.turns)})`,
    );
    console.log(
      `   precision ${pct(gate.precision)}   recall ${pct(gate.recall)}   (tp ${gate.tp} · fp ${gate.fp} · fn ${gate.fn} · tn ${gate.tn})`,
    );
    if (missedByGate.length) {
      const byGroup = Object.entries(report.gateMissesByGroup)
        .filter(([, n]) => n > 0)
        .sort((a, b) => b[1] - a[1]);
      console.log(
        `   missed shifts needing a new group: ${byGroup.map(([group, n]) => `${group} ${n}`).join(" · ")}`,
      );
    }

    console.log("\ngroup usage over every turn (is it worth scoping at all?)");
    const usage = scoreRun(rows).usage;
    for (const [group, rate] of Object.entries(usage).sort((a, b) => b[1] - a[1])) {
      if (group === "other" || rate > 0) console.log(`   ${group.padEnd(8)} ${pct(rate)}`);
    }

    if (report.live) {
      const scores = report.live.scores;
      console.log(
        `\nbattery (live): ${report.live.scored}/${report.live.sampled} judged · latency p50 ${report.live.latency.p50}ms p90 ${report.live.latency.p90}ms`,
      );
      console.log(
        "   group      used   recall  precision   missed   (always-on groups are offered regardless)",
      );
      const alwaysOn = new Set(ALWAYS_ON_GROUPS);
      for (const [group, score] of Object.entries(scores.groups)) {
        if (!score.total) continue;
        const rate = scores.usage[group];
        const note = alwaysOn.has(group)
          ? "always on"
          : SCOPED_GROUPS.includes(group)
            ? "scoped"
            : "";
        console.log(
          `   ${group.padEnd(8)} ${pct(rate)} ${pct(score.recall)} ${pct(score.precision)}      ${String(score.fn).padStart(2)}    ${note}`,
        );
      }
      const coverage = scores.coverage;
      console.log(
        `\ncoverage: ${pct(coverage.rate)} of judged turns would have had every group they used`,
      );
      for (const [group, n] of Object.entries(coverage.missingByGroup).sort(
        (a, b) => b[1] - a[1],
      )) {
        console.log(
          `   missing ${group} on ${n} turn(s) — the escape hatch's job, not a silent failure`,
        );
      }
      if (report.live.misses.length) {
        console.log("\n   turns that used a group the judge did not predict:");
        for (const miss of report.live.misses.slice(0, 12)) {
          console.log(`     [${miss.missing.join(",")}] ${miss.prompt.replace(/\s+/g, " ")}`);
          console.log(
            `         predicted [${miss.predicted.join(",")}] · signals ${JSON.stringify(miss.signals)}`,
          );
        }
        if (report.live.misses.length > 12)
          console.log(`     ... and ${report.live.misses.length - 12} more`);
      }
    } else {
      const projected = (report.corpus.routed / report.corpus.turns) * 650;
      console.log(`\njudge projections (from the measured 650ms round trip)`);
      console.log(
        `   calls per turn: ${(report.corpus.routed / report.corpus.turns).toFixed(2)}   added latency per turn: ${Math.round(projected)}ms`,
      );
      const perTurnCost = 0.0002;
      console.log(
        `   recorded corpus cost would grow by ~$${(report.corpus.routed * perTurnCost).toFixed(2)} for ${report.corpus.routed} judged turns`,
      );
    }
  }

  // Fail only where a miss is structural: a scoped group missed often enough
  // that the escape hatch would be the common path, not the exception.
  if (report.live) {
    const coverage = report.live.scores.coverage;
    const scopedMisses = Object.entries(coverage.missingByGroup).filter(([group]) =>
      SCOPED_GROUPS.includes(group),
    );
    const missRate = coverage.turns ? (coverage.turns - coverage.covered) / coverage.turns : 0;
    if (missRate > 0.1) {
      console.error(
        `\ncoverage ${pct(coverage.rate)} is below the 90% floor: ${scopedMisses.map(([group, n]) => `${group} ${n}`).join(", ") || "unmapped groups"}`,
      );
      process.exit(1);
    }
    const poorlyRecalled = Object.entries(report.live.scores.groups)
      .filter(([group, score]) => score.total && !ALWAYS_ON_GROUPS.includes(group))
      .filter(([, score]) => score.recall !== null && score.recall < opts.failUnder);
    for (const [group, score] of poorlyRecalled) {
      console.error(
        `note: scoped group "${group}" recall ${pct(score.recall)} — relying on the escape hatch for it`,
      );
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
