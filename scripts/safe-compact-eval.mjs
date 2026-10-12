// safe-compact-eval.mjs — does safe-compact produce a handoff on real sessions?
//
// The unit tests run on a fake `ask`, so they cannot see what failed in
// practice: real Jev answers on real transcripts produced handoffs too large to
// accept, and every rejection was rebuilt from scratch at the next turn. This
// replays real pi sessions to the point where the hard threshold fires, runs
// the production boundary path with real TypeSafe calls, then grows the
// context by one more turn and runs it again, as the next turn_end would.
//
// Per session it reports whether a handoff was produced (or why not), its size
// against the span it replaces, the share of it that is raw tool output, and
// the Jev calls and seconds for the first attempt and the retry.
//
// Costs real TypeSafe calls (hundreds per session). Read-only.
//
// The default corpus is the largest session per project directory.
//
//   node scripts/safe-compact-eval.mjs [--sessions 5] [--threshold 210000] [--json] [file.jsonl ...]

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import {
  buildBoundaryCompaction,
  memoizeAsk,
  planBoundary,
} from "../packages/safe-compact/plan.mjs";
import { estimateTokens } from "../packages/safe-compact/segment.mjs";
import { askSystemOne } from "../shared/systemone.mjs";

const { values, positionals } = parseArgs({
  options: {
    sessions: { type: "string", default: "5" },
    threshold: { type: "string", default: "210000" },
    json: { type: "boolean", default: false },
  },
  allowPositionals: true,
});
const threshold = Number(values.threshold);
const KEEP_RECENT = 20000;
/** Roughly one more turn of work before the retry. */
const RETRY_GROWTH = 5000;
const MIN_REPLACED = 20000;

const entryTokens = (entry) =>
  entry.messages.reduce(
    (sum, m) => sum + estimateTokens(JSON.stringify(m.content ?? m.summary ?? m.output ?? "")),
    0,
  );

/** Projected entries the way turn_end sees them: a compaction resets the context. */
function project(lines, limit) {
  const entries = [];
  let tokens = 0;
  let index = 0;
  for (; index < lines.length; index++) {
    const e = lines[index];
    if (e.type === "compaction") {
      const summary = { role: "compactionSummary", summary: e.summary };
      entries.length = 0;
      entries.push({ sourceEntry: e, messages: [summary] });
      tokens = entryTokens(entries[0]);
    } else if (e.type === "message" && e.message) {
      const entry = { sourceEntry: e, messages: [e.message] };
      entries.push(entry);
      tokens += entryTokens(entry);
    } else continue;
    if (tokens >= limit) return { entries: [...entries], tokens, next: index + 1 };
  }
  return null;
}

function corpus(count) {
  if (positionals.length) return positionals;
  const root = path.join(homedir(), ".pi", "agent", "sessions");
  return readdirSync(root)
    .flatMap((dir) =>
      readdirSync(path.join(root, dir))
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => path.join(root, dir, f)),
    )
    .map((file) => ({ file, size: statSync(file).size }))
    .sort((a, b) => b.size - a.size)
    .map(({ file }) => file)
    .filter((file, i, all) => all.findIndex((f) => path.dirname(f) === path.dirname(file)) === i)
    .slice(0, count * 4);
}

async function attempt(entries, ask, counter) {
  const before = counter.calls;
  let reason = null;
  const plan = planBoundary({ entries, keepRecentTokens: KEEP_RECENT });
  const started = performance.now();
  const draft = await buildBoundaryCompaction({
    entries,
    keepRecentTokens: KEEP_RECENT,
    ask,
    onRejected: (why) => (reason = why),
  });
  const seconds = (performance.now() - started) / 1000;
  const handoff = draft ? estimateTokens(draft.summary) : null;
  const toolTokens = draft?.details?.safeCompact?.tokens?.toolResult ?? 0;
  return {
    ok: Boolean(draft),
    reason,
    replaced: plan?.summarizedTokens ?? 0,
    handoff,
    ratio: draft ? handoff / plan.summarizedTokens : null,
    toolShare: draft ? toolTokens / handoff : null,
    // Entries the budget could not cut: user constraints and verification-forced copies.
    pinned: draft?.details?.safeCompact?.pinned ?? null,
    forced: draft?.details?.safeCompact?.forced ?? null,
    tokens: draft?.details?.safeCompact?.tokens ?? null,
    calls: counter.calls - before,
    seconds,
  };
}

const results = [];
for (const file of corpus(Number(values.sessions))) {
  if (results.length >= Number(values.sessions)) break;
  const lines = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  const first = project(lines, threshold);
  // One session per project, and only spans worth compacting: a tiny span
  // says nothing about whether a real handoff fits.
  const plan = first && planBoundary({ entries: first.entries, keepRecentTokens: KEEP_RECENT });
  if (!plan || plan.summarizedTokens < MIN_REPLACED) continue;
  const retryAt = project(lines, first.tokens + RETRY_GROWTH);
  // One ask per session, shared by both attempts, exactly as one session's turn_end handlers share it.
  // Calls are counted under the memo, so they are real TypeSafe requests.
  const counter = { calls: 0 };
  const ask = memoizeAsk((request) => {
    counter.calls++;
    return askSystemOne(request);
  });
  const initial = await attempt(first.entries, ask, counter);
  const retry = retryAt ? await attempt(retryAt.entries, ask, counter) : null;
  const row = { session: path.basename(file).slice(0, 19), context: first.tokens, initial, retry };
  results.push(row);
  if (!values.json) {
    const pct = (value) => (value === null ? "  -  " : `${Math.round(value * 100)}%`.padStart(5));
    const r = initial;
    console.log(
      `${row.session}  ${r.ok ? "ok  " : "FAIL"}  replaced ${String(r.replaced).padStart(6)}  ` +
        `handoff ${pct(r.ratio)}  tool ${pct(r.toolShare)}  ${String(r.calls).padStart(4)} calls ${r.seconds.toFixed(1).padStart(5)}s` +
        (retry
          ? `  | retry ${retry.ok ? "ok  " : "FAIL"} ${String(retry.calls).padStart(4)} calls ${retry.seconds.toFixed(1).padStart(5)}s`
          : "") +
        (r.reason ? `\n    ${r.reason}` : ""),
    );
  }
}

const median = (list) => {
  const sorted = list.filter((v) => v !== null).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};
const summary = {
  sessions: results.length,
  succeeded: results.filter((r) => r.initial.ok).length,
  retrySucceeded: results.filter((r) => r.retry?.ok).length,
  medianRatio: median(results.map((r) => r.initial.ratio)),
  medianToolShare: median(results.map((r) => r.initial.toolShare)),
  medianSeconds: median(results.map((r) => r.initial.seconds)),
  medianRetryCalls: median(results.map((r) => r.retry?.calls ?? null)),
  medianRetrySeconds: median(results.map((r) => r.retry?.seconds ?? null)),
};
if (values.json) console.log(JSON.stringify({ summary, results }, null, 2));
else console.log(JSON.stringify(summary));
