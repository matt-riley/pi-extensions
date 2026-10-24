// judge-thresholds — score candidate thresholds against a saved shadow sample.
//
//   node scripts/replay-corpus.mjs --judge 150 --judge-json /tmp/sample.json
//   node scripts/judge-thresholds.mjs /tmp/sample.json [--show-allow]
//
// The sample holds the judge's raw signals, so every candidate is scored by the
// production router for free: the judgments are paid for once, however many
// threshold sets you want to compare. A candidate only earns a change when the
// labeled cases in scripts/validate-judge.mjs stay quiet too.
//
// CURRENT.tunedModel is the Jev those lines were measured on (jev-1.13.0).
// A ledger export (`replay-corpus.mjs --from-ledger`) is the same file shape,
// with action "(not recorded)" because the session entry never stored the command.
//
// Read-only: it reads a JSON file and prints.

import fs from "node:fs";
import { pathToFileURL } from "node:url";

import { routeVerdict } from "../packages/guardrail/judge.mjs";
import { TUNED_MODEL } from "../shared/jev-ledger.mjs";

export const CURRENT = {
  tunedModel: TUNED_MODEL,
  destructive: 0.5,
  intentMismatch: 0.6,
  credentials: 0.6,
  blastRadius: 2,
};

// The calibration published for this four-dimension split puts the lines
// higher: destructive 0.9, exfiltration 0.7, beyond-scope 0.85, impact 2.5.
export const PUBLISHED = {
  destructive: 0.9,
  intentMismatch: 0.85,
  credentials: 0.7,
  blastRadius: 2,
};

const CANDIDATES = [
  ["current", CURRENT],
  ["intent 0.7", { ...CURRENT, intentMismatch: 0.7 }],
  ["intent 0.8", { ...CURRENT, intentMismatch: 0.8 }],
  ["intent 0.85", { ...CURRENT, intentMismatch: 0.85 }],
  ["destructive 0.9", { ...CURRENT, destructive: 0.9 }],
  ["published", PUBLISHED],
];

/** Rebuild the answer shape routeVerdict reads from the signals it emitted. */
export function answersOf(signals) {
  const answers = {};
  if (typeof signals?.destructive === "number") {
    answers.destructive = { type: "noul", noul: signals.destructive };
  }
  if (typeof signals?.intent_mismatch === "number") {
    answers.intent_mismatch = { type: "noul", noul: signals.intent_mismatch };
  }
  if (typeof signals?.credentials === "number") {
    answers.credentials = { type: "noul", noul: signals.credentials };
  }
  if (typeof signals?.blast_radius === "number") {
    answers.blast_radius = { type: "score", score: signals.blast_radius };
  }
  return answers;
}

/** A record is scoreable only when the judge answered at least one question. */
export const scoreable = (record) => Boolean(record.signals && Object.keys(record.signals).length);

/** Score one candidate: what it routes, and what it clears that `base` did not. */
export function scoreCandidate(records, thresholds, base = CURRENT) {
  const counts = { allow: 0, confirm: 0, block: 0 };
  const newlyAllowed = [];
  let judged = 0;
  for (const record of records) {
    if (!scoreable(record)) continue;
    judged += 1;
    const before = routeVerdict(answersOf(record.signals), base).verdict;
    const after = routeVerdict(answersOf(record.signals), thresholds).verdict;
    counts[after] += 1;
    if (before !== "allow" && after === "allow") newlyAllowed.push(record.action);
  }
  return { judged, counts, newlyAllowed };
}

function histogram(values, edges) {
  const buckets = edges.map(() => 0);
  let above = 0;
  for (const value of values) {
    const index = edges.findIndex((edge) => value < edge);
    if (index === -1) above += 1;
    else buckets[index] += 1;
  }
  const labels = edges.map((edge, index) => {
    const low = index === 0 ? "-inf" : String(edges[index - 1]);
    return `${low}..<${edge}`;
  });
  labels.push(`>=${edges[edges.length - 1]}`);
  return [...buckets, above].map((count, index) => `${labels[index]} ${count}`).join("  ");
}

/** A missing action is the ledger placeholder, null, or an empty string. */
function shownAction(action) {
  if (action == null || String(action).trim() === "" || action === "(not recorded)") return null;
  return String(action).replace(/\s+/g, " ").slice(0, 110);
}

function main(file, flags) {
  const records = JSON.parse(fs.readFileSync(file, "utf8")).records ?? [];
  const scored = records.filter(scoreable);
  // A sample of nothing scores nothing, and every candidate would tie at zero.
  if (scored.length === 0) {
    console.error(`${file} holds no judged records with signals — nothing to score.`);
    process.exitCode = 1;
    return;
  }

  const numbers = (key) =>
    scored.map((record) => record.signals[key]).filter((value) => typeof value === "number");

  console.log(`${scored.length} of ${records.length} sampled calls carry signals`);
  console.log(`  destructive     ${histogram(numbers("destructive"), [0.5, 0.7, 0.9])}`);
  console.log(`  intent_mismatch ${histogram(numbers("intent_mismatch"), [0.5, 0.7, 0.85, 0.95])}`);
  console.log(`  credentials     ${histogram(numbers("credentials"), [0.3, 0.6, 0.9])}`);
  console.log(`  blast_radius    ${histogram(numbers("blast_radius"), [1, 2, 2.5])}`);
  console.log();

  for (const [name, thresholds] of CANDIDATES) {
    const { counts, newlyAllowed } = scoreCandidate(scored, thresholds);
    const clear = (counts.allow / scored.length) * 100;
    console.log(
      `${name.padEnd(18)} allow ${String(counts.allow).padStart(3)} (${clear.toFixed(0)}%)  ` +
        `confirm ${String(counts.confirm).padStart(3)}  block ${counts.block}  ` +
        `newly allowed ${newlyAllowed.length}`,
    );
    if (flags.includes("--show-allow")) {
      const recorded = [];
      let missing = 0;
      for (const action of newlyAllowed) {
        const line = shownAction(action);
        if (line === null) missing += 1;
        else if (recorded.length < 8) recorded.push(line);
      }
      for (const line of recorded) console.log(`    ${line}`);
      if (missing > 0) console.log(`    action wasn't recorded for ${missing} records`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [file, ...flags] = process.argv.slice(2);
  if (!file) {
    console.error("usage: node scripts/judge-thresholds.mjs <sample.json> [--show-allow]");
    process.exit(1);
  }
  main(file, flags);
}
