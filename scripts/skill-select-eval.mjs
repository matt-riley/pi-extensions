#!/usr/bin/env node
/**
 * skill-select-eval.mjs — does TypeSafe selection beat lexical ranking on this library?
 *
 * Runs every case in packages/skill-select/eval/cases.json through two variants and
 * reports top-1 / hit@5 / wrong-route / needless-load rates:
 *
 *   lexical   rankSkills only (offline)
 *   rerank    selectSkills: wide pool, ordered by probability, explicit "none fit"
 *
 * Case sources: `history` (the SKILL.md the agent read after a real skill_select call —
 * a weak label), `paraphrase` (hand-written, little word overlap) and `none` (no skill
 * should apply). The labels are not independent ground truth; treat results as directional.
 *
 * Usage: node scripts/skill-select-eval.mjs [--variants lexical,rerank] [--json out.json]
 * Live variants make TypeSafe calls (about one per case) and need a reachable key.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

import { discoverSkills, rankSkills, resolveRoots } from "../packages/skill-select/library.mjs";
import { selectSkills } from "../packages/skill-select/select.mjs";

const LIMIT = 5;
const CONCURRENCY = 4;
const cases = JSON.parse(
  readFileSync(new URL("../packages/skill-select/eval/cases.json", import.meta.url), "utf8"),
);

const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const variants = (flag("--variants") ?? "lexical,rerank").split(",");

const skills = await discoverSkills({
  roots: resolveRoots({ cwd: process.cwd(), home: homedir(), env: process.env }),
});
const known = new Set(skills.map((skill) => skill.name));
for (const c of cases) {
  for (const name of c.accept) {
    if (!known.has(name)) throw new Error(`case "${c.query}" labels unknown skill "${name}"`);
  }
}

const RUN = {
  async lexical(query) {
    const matches = rankSkills(skills, query, { limit: LIMIT });
    return { names: matches.map((m) => m.name), abstain: matches.length === 0 };
  },
  async rerank(query) {
    const out = await selectSkills({ skills, query, limit: LIMIT });
    return {
      names: out.matches.map((m) => m.name),
      abstain: out.matches.length === 0 || out.note !== null,
      reason: out.reason,
    };
  },
};

async function pool(items, worker) {
  const results = Array.from({ length: items.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index]);
      }
    }),
  );
  return results;
}

const report = {};
for (const variant of variants) {
  const rows = await pool(cases, async (c) => {
    const started = Date.now();
    const out = await RUN[variant](c.query);
    return { ...c, ...out, ms: Date.now() - started };
  });
  const labelled = rows.filter((r) => r.source !== "none");
  const none = rows.filter((r) => r.source === "none");
  const split = (source) => rows.filter((r) => r.source === source);
  const top1 = (r) => !r.abstain && r.accept.includes(r.names[0]);
  const rate = (list, fn) => `${list.filter(fn).length}/${list.length}`;
  report[variant] = {
    top1: rate(labelled, top1),
    top1_history: rate(split("history"), top1),
    top1_paraphrase: rate(split("paraphrase"), top1),
    hit_at_5: rate(labelled, (r) => r.names.some((n) => r.accept.includes(n))),
    wrong_route: rate(labelled, (r) => !r.abstain && r.names.length > 0 && !top1(r)),
    abstained_on_labelled: rate(labelled, (r) => r.abstain),
    correct_abstain: rate(none, (r) => r.abstain),
    needless_load: rate(none, (r) => !r.abstain),
    mean_ms: Math.round(rows.reduce((sum, r) => sum + r.ms, 0) / rows.length),
    fell_back: rows.filter((r) => r.reason && !["wide", "shortlist", "declined"].includes(r.reason))
      .length,
    misses: labelled
      .filter((r) => !top1(r))
      .map((r) => ({
        query: r.query,
        want: r.accept,
        got: r.abstain ? `(abstained) ${r.names[0] ?? ""}` : r.names.slice(0, 3),
      })),
    false_loads: none
      .filter((r) => !r.abstain)
      .map((r) => ({ query: r.query, got: r.names.slice(0, 2) })),
  };
}

const out = flag("--json");
if (out)
  writeFileSync(
    out,
    JSON.stringify({ total: skills.length, cases: cases.length, report }, null, 2),
  );
const cols = [
  "top1",
  "top1_history",
  "top1_paraphrase",
  "hit_at_5",
  "wrong_route",
  "abstained_on_labelled",
  "correct_abstain",
  "needless_load",
  "mean_ms",
  "fell_back",
];
console.log(`${cases.length} cases, ${skills.length} skills\n`);
console.log(["metric".padEnd(24), ...variants.map((v) => v.padEnd(10))].join(""));
for (const col of cols) {
  console.log([col.padEnd(24), ...variants.map((v) => String(report[v][col]).padEnd(10))].join(""));
}
