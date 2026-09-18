// context-report.mjs — what does context actually cost per turn?
//
// Reads pi's own session transcripts and reports where the tokens go, so that
// context budgeting is designed against measurements rather than intuition.
//
// Four questions it answers:
//
//   1. How big does the context get inside a turn, and how many times over is
//      it re-sent? (billed input ÷ final context = re-send factor)
//   2. How much of that re-send is cache-discounted rather than paid full?
//   3. How much of a turn's context is material the turn itself added, versus
//      the prefix it inherited? (prefix share)
//   4. At what context size does compaction actually fire?
//
// Two data caveats it reports rather than hides: some providers emit garbage
// cost figures (excluded, and counted), and subscription providers report 0.
//
// Read-only. `node scripts/context-report.mjs [--json]`

import path from "node:path";
import { homedir } from "node:os";

import { findSessionFiles, percentile, readSession } from "./lib/sessions.mjs";

const SESSIONS_DIR = path.join(homedir(), ".pi", "agent", "sessions");

const files = findSessionFiles(SESSIONS_DIR);
const turns = [];
const requests = [];
const compactions = [];
const byModel = new Map();
const costParts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
let skippedCostRecords = 0;
let skippedCostTotal = 0;

for (const file of files) {
  const session = readSession(file);
  compactions.push(...session.compactions);

  for (const turn of session.turns) {
    const row = {
      requests: 0,
      billed: 0,
      cacheRead: 0,
      fresh: 0,
      contextFirst: null,
      contextLast: 0,
      contexts: [],
      cost: 0,
      models: new Set(),
    };

    for (const request of turn.requests) {
      // A handful of providers emit nonsense (openrouter/auto reported -$2,351
      // across seven requests). Counting them would make every total a lie.
      const suspect = request.cost.total < 0;
      const cost = suspect ? 0 : request.cost.total;
      if (suspect) {
        skippedCostRecords++;
        skippedCostTotal += request.cost.total;
      } else {
        costParts.input += request.cost.input;
        costParts.output += request.cost.output;
        costParts.cacheRead += request.cost.cacheRead;
        costParts.cacheWrite += request.cost.cacheWrite;
      }

      requests.push({
        context: request.context,
        fresh: request.input,
        cacheRead: request.cacheRead,
        output: request.output,
        cost,
        model: request.model,
      });

      const agg = byModel.get(request.model) ?? {
        requests: 0,
        billed: 0,
        cacheRead: 0,
        output: 0,
        cost: 0,
        zeros: 0,
      };
      agg.requests++;
      agg.billed += request.context;
      agg.cacheRead += request.cacheRead;
      agg.output += request.output;
      agg.cost += cost;
      if (request.cost.total === 0) agg.zeros++;
      byModel.set(request.model, agg);

      row.requests++;
      row.billed += request.context;
      row.cacheRead += request.cacheRead;
      row.fresh += request.input;
      row.contextFirst ??= request.context;
      row.contextLast = request.context;
      row.contexts.push(request.context);
      row.cost += cost;
      row.models.add(request.model);
    }

    if (row.requests) turns.push(row);
  }
}

const live = turns.filter((t) => t.requests > 0);
// A turn whose final request had almost no context (a failed call, an aborted
// one) makes the re-send ratio explode into meaningless territory. Only turns
// that ended with a real context are counted for that metric.
const measured = live.filter((t) => t.contextLast >= 1000);
const skippedResend = live.length - measured.length;
const billed = requests.reduce((n, r) => n + r.context, 0);
const freshTokens = requests.reduce((n, r) => n + r.fresh, 0);
const cacheReadTokens = requests.reduce((n, r) => n + r.cacheRead, 0);
const outputTokens = requests.reduce((n, r) => n + r.output, 0);
const totalCost = requests.reduce((n, r) => n + r.cost, 0);
const resend = (t) => t.billed / Math.max(t.contextLast, 1);
const prefixShare = (t) =>
  t.contextLast ? 1 - (t.contextLast - t.contextFirst) / t.contextLast : 0;
/** Median context of one turn's requests — weight each turn equally, not each request. */
function turnTypicalContext(t) {
  const values = t.contexts ?? [];
  return values.length ? percentile(values, 0.5) : 0;
}

const report = {
  corpus: {
    sessions: files.length,
    turns: turns.length,
    turnsWithRequests: live.length,
    requests: requests.length,
  },
  perRequest: {
    p50: percentile(
      requests.map((r) => r.context),
      0.5,
    ),
    p90: percentile(
      requests.map((r) => r.context),
      0.9,
    ),
    p99: percentile(
      requests.map((r) => r.context),
      0.99,
    ),
    max: Math.max(0, ...requests.map((r) => r.context)),
  },
  perTurn: {
    requests: {
      p50: percentile(
        live.map((t) => t.requests),
        0.5,
      ),
      p90: percentile(
        live.map((t) => t.requests),
        0.9,
      ),
    },
    typicalContext: {
      p50: percentile(live.map(turnTypicalContext), 0.5),
      p90: percentile(live.map(turnTypicalContext), 0.9),
    },
    billed: {
      p50: percentile(
        live.map((t) => t.billed),
        0.5,
      ),
      p90: percentile(
        live.map((t) => t.billed),
        0.9,
      ),
    },
    finalContext: {
      p50: percentile(
        live.map((t) => t.contextLast),
        0.5,
      ),
      p90: percentile(
        live.map((t) => t.contextLast),
        0.9,
      ),
    },
    growth: {
      p50: percentile(
        live.map((t) => t.contextLast - t.contextFirst),
        0.5,
      ),
      p90: percentile(
        live.map((t) => t.contextLast - t.contextFirst),
        0.9,
      ),
    },
    prefixShare: {
      p50: percentile(live.map(prefixShare), 0.5),
      p90: percentile(live.map(prefixShare), 0.9),
    },
    resend: {
      p50: percentile(measured.map(resend), 0.5),
      p90: percentile(measured.map(resend), 0.9),
      max: Math.max(0, ...measured.map(resend)),
      skippedTurns: skippedResend,
    },
    cost: {
      p50: percentile(
        live.map((t) => t.cost),
        0.5,
      ),
      p90: percentile(
        live.map((t) => t.cost),
        0.9,
      ),
    },
    multimodelTurns: live.filter((t) => t.models.size > 1).length,
  },
  tokens: {
    billed,
    freshTokens,
    cacheReadTokens,
    outputTokens,
    cacheShare: billed ? cacheReadTokens / billed : 0,
  },
  cost: {
    total: totalCost,
    perTurn: live.length ? totalCost / live.length : 0,
    parts: costParts,
    skippedRecords: skippedCostRecords,
    skippedTotal: skippedCostTotal,
  },
  compaction: {
    count: compactions.length,
    tokensBefore: {
      p50: percentile(
        compactions.map((c) => c.tokensBefore),
        0.5,
      ),
      p90: percentile(
        compactions.map((c) => c.tokensBefore),
        0.9,
      ),
      max: Math.max(0, ...compactions.map((c) => c.tokensBefore)),
    },
    requestsBetween: {
      p50: percentile(
        compactions.map((c) => c.requests),
        0.5,
      ),
      p90: percentile(
        compactions.map((c) => c.requests),
        0.9,
      ),
    },
  },
  models: [...byModel.entries()]
    .map(([model, a]) => ({ model, ...a, cacheShare: a.billed ? a.cacheRead / a.billed : 0 }))
    .sort((a, b) => b.billed - a.billed),
};

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const n = (x) => Math.round(x).toLocaleString();
  const pct = (x) => `${(100 * x).toFixed(1)}%`;

  console.log(
    `corpus: ${report.corpus.sessions} sessions · ${report.corpus.turns} turns · ${report.corpus.requests} requests\n`,
  );

  console.log("context the model read, per request");
  console.log(
    `   p50 ${n(report.perRequest.p50)}   p90 ${n(report.perRequest.p90)}   p99 ${n(report.perRequest.p99)}   max ${n(report.perRequest.max)}\n`,
  );

  console.log("per turn");
  console.log(
    `   requests          p50 ${report.perTurn.requests.p50}    p90 ${report.perTurn.requests.p90}`,
  );
  console.log(
    `   context per call  p50 ${n(report.perTurn.typicalContext.p50)}    p90 ${n(report.perTurn.typicalContext.p90)}   (median call within a turn)`,
  );
  console.log(
    `   context read      p50 ${n(report.perTurn.billed.p50)}    p90 ${n(report.perTurn.billed.p90)}   (sum over requests)`,
  );
  console.log(
    `   final context     p50 ${n(report.perTurn.finalContext.p50)}    p90 ${n(report.perTurn.finalContext.p90)}`,
  );
  console.log(
    `   grown during turn p50 ${n(report.perTurn.growth.p50)}    p90 ${n(report.perTurn.growth.p90)}`,
  );
  console.log(
    `   prefix share      p50 ${pct(report.perTurn.prefixShare.p50)}  p90 ${pct(report.perTurn.prefixShare.p90)}   (inherited vs added)`,
  );
  console.log(
    `   re-send factor    p50 ${report.perTurn.resend.p50.toFixed(1)}x   p90 ${report.perTurn.resend.p90.toFixed(1)}x   max ${report.perTurn.resend.max.toFixed(0)}x`,
  );
  if (report.perTurn.resend.skippedTurns) {
    console.log(
      `     (${report.perTurn.resend.skippedTurns} turn(s) excluded: they ended with an empty context, so the ratio is meaningless)`,
    );
  }
  console.log(
    `   cost              p50 $${report.perTurn.cost.p50.toFixed(4)}   p90 $${report.perTurn.cost.p90.toFixed(4)}`,
  );
  console.log(`   turns that changed model mid-turn: ${report.perTurn.multimodelTurns}\n`);

  console.log("where the input tokens go");
  console.log(`   context read        ${n(report.tokens.billed)}`);
  console.log(
    `     cache read        ${n(report.tokens.cacheReadTokens)}   ${pct(report.tokens.cacheShare)} of it, discounted`,
  );
  console.log(
    `     fresh             ${n(report.tokens.freshTokens)}   ${pct(1 - report.tokens.cacheShare)} at full price`,
  );
  console.log(`   output tokens       ${n(report.tokens.outputTokens)}\n`);

  console.log(
    `cost: $${report.cost.total.toFixed(2)} over ${report.corpus.turns} turns · $${report.cost.perTurn.toFixed(4)} per turn`,
  );
  const parts = report.cost.parts;
  const totalParts = parts.input + parts.output + parts.cacheRead + parts.cacheWrite;
  if (totalParts > 0) {
    console.log("   where the money went");
    console.log(
      `     output tokens      $${parts.output.toFixed(2)}  ${pct(parts.output / totalParts)}`,
    );
    console.log(
      `     fresh input        $${parts.input.toFixed(2)}  ${pct(parts.input / totalParts)}`,
    );
    console.log(
      `     cache reads        $${parts.cacheRead.toFixed(2)}  ${pct(parts.cacheRead / totalParts)}`,
    );
    console.log(
      `     cache writes       $${parts.cacheWrite.toFixed(2)}  ${pct(parts.cacheWrite / totalParts)}`,
    );
  }
  if (report.cost.skippedRecords) {
    console.log(
      `   excluded ${report.cost.skippedRecords} bogus negative-cost record(s) summing to $${report.cost.skippedTotal.toFixed(2)} (provider error)`,
    );
  }
  console.log();

  console.log("compaction");
  console.log(`   events ${report.compaction.count}`);
  console.log(
    `   tokens before     p50 ${n(report.compaction.tokensBefore.p50)}   p90 ${n(report.compaction.tokensBefore.p90)}   max ${n(report.compaction.tokensBefore.max)}`,
  );
  console.log(
    `   requests between  p50 ${report.compaction.requestsBetween.p50}   p90 ${report.compaction.requestsBetween.p90}\n`,
  );

  console.log("by model (top 10 by tokens read)");
  for (const m of report.models.slice(0, 10)) {
    console.log(
      `   ${m.model.padEnd(38)} reqs ${String(m.requests).padStart(5)}  read ${n(m.billed).padStart(12)}  cached ${pct(m.cacheShare).padStart(6)}  ${m.zeros === m.requests ? "(no cost reported)" : `$${m.cost.toFixed(2)}`}`,
    );
  }

  const priced = report.models.filter((m) => m.cost > 0).sort((a, b) => b.cost - a.cost);
  const top = priced.slice(0, 3);
  const topCost = top.reduce((sum, m) => sum + m.cost, 0);
  const topReqs = top.reduce((sum, m) => sum + m.requests, 0);
  if (topCost > 0) {
    console.log("\ncost concentration");
    for (const m of top) {
      console.log(
        `   ${m.model.padEnd(38)} ${pct(m.cost / report.cost.total).padStart(6)} of spend  on ${pct(m.requests / report.corpus.requests)} of calls`,
      );
    }
    console.log(
      `   top 3 models: ${pct(topCost / report.cost.total)} of spend on ${pct(topReqs / report.corpus.requests)} of calls`,
    );
  }
}
