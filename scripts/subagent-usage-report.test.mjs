import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildReport,
  formatReport,
  judgmentKind,
  triageLabel,
} from "./subagent-usage-report-lib.mjs";

const SENTINEL = "SENTINEL_subagent_usage_9f3c2a";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureRoot = path.join(scriptDir, "fixtures/subagent-usage");
const reportScript = path.join(scriptDir, "subagent-usage-report.mjs");
const loneDir = path.join(fixtureRoot, "lone");
const fanoutDir = path.join(fixtureRoot, "fanout");
const tokensDir = path.join(fixtureRoot, "tokens");
const grepDir = path.join(fixtureRoot, "grep-only");
const foldDir = path.join(fixtureRoot, "fold");
const rejectDir = path.join(fixtureRoot, "reject");

test("triage choice indexes follow the criteria order in judge.mjs", () => {
  const source = fs.readFileSync(
    new URL("../packages/subagents/judge.mjs", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("function triageQuestions");
  const end = source.indexOf("function scopeQuestions");
  const criteria = source.slice(start, end);
  const keys = [];
  for (const match of criteria
    .slice(criteria.indexOf("criteria:"))
    .matchAll(/^\s{8}([a-z_]+):/gm)) {
    keys.push(match[1]);
  }
  assert.deepEqual(keys, ["answered", "partial", "blocked", "off_task"]);
  assert.deepEqual(
    [0, 1, 2, 3].map((index) => triageLabel(index)),
    keys,
  );
  assert.equal(triageLabel(4), null);
  assert.equal(triageLabel("partial"), null);
});

test("ledger question ids distinguish preflight, triage and scope", () => {
  assert.equal(judgmentKind([{ id: "self_contained", kind: "noul" }]), "preflight");
  assert.equal(
    judgmentKind([
      { id: "self_contained", kind: "noul" },
      { id: "needs_decision", kind: "noul" },
    ]),
    "preflight",
  );
  assert.equal(judgmentKind([{ id: "outcome", kind: "choice" }]), "triage");
  assert.equal(judgmentKind([{ id: "out_of_scope", kind: "noul" }]), "scope");
  assert.equal(judgmentKind([{ id: "destructive", kind: "noul" }]), null);
  assert.equal(judgmentKind(undefined), null);
});

test("a lone scout takes partial from the ledger choice index, not the result text", () => {
  const report = buildReport({ dir: loneDir, builtins: ["scout"] });
  assert.equal(report.spawns, 1);
  const scout = report.types.find((row) => row.type === "scout");
  assert.equal(scout.spawns, 1);
  assert.equal(scout.lone, 1);
  assert.equal(scout.fanout, 0);
  assert.deepEqual(scout.triage, { answered: 0, partial: 1, blocked: 0, off_task: 0 });
});

test("overlapping children are a fan-out only when each started before the first finished", () => {
  const report = buildReport({
    dir: fanoutDir,
    builtins: ["scout", "worker", "oracle", "verifier"],
  });
  const row = (type) => report.types.find((item) => item.type === type);
  const scout = row("scout");
  assert.equal(scout.spawns, 2);
  assert.equal(scout.fanout, 1);
  assert.equal(scout.lone, 1);
  assert.equal(scout.triage.answered, 1);
  assert.equal(scout.triage.partial, 1);
  const worker = row("worker");
  assert.equal(worker.spawns, 1);
  assert.equal(worker.fanout, 1);
  assert.equal(worker.lone, 0);
  assert.equal(worker.triage.blocked, 1);
  assert.equal(worker.triage.answered, 0);
  const verifier = row("verifier");
  assert.equal(verifier.fanout, 1);
  assert.equal(verifier.triage.blocked, 1);
  const oracle = row("oracle");
  assert.equal(oracle.fanout, 1);
  assert.equal(oracle.triage.answered, 1);
  assert.equal(oracle.triage.blocked, 0);
});

test("median and p90 tokens come from tool-result usage and duration is the spawn wall clock", () => {
  const report = buildReport({ dir: tokensDir, builtins: ["scout"] });
  const scout = report.types.find((row) => row.type === "scout");
  assert.equal(scout.spawns, 10);
  assert.deepEqual(scout.tokens, { p50: 50, p90: 90 });
  assert.deepEqual(scout.durationMs, { p50: 5000, p90: 9000 });
});

test("a lossy handoff is a later parent read of a file the child read", () => {
  const lone = buildReport({ dir: loneDir, builtins: ["scout"] });
  const scout = lone.types.find((row) => row.type === "scout");
  assert.equal(scout.lossyHandoffs, 1);

  const grep = buildReport({ dir: grepDir, builtins: ["researcher"] });
  const researcher = grep.types.find((row) => row.type === "researcher");
  assert.equal(researcher.spawns, 1);
  assert.equal(researcher.lossyHandoffs, 0);
});

test("fold candidates are mostly lone and more often partial or blocked", () => {
  const report = buildReport({
    dir: foldDir,
    builtins: ["researcher", "scout", "oracle", "worker"],
  });
  assert.deepEqual(report.foldCandidates, ["researcher"]);
});

test("text and json output are counts only and never echo a transcript sentinel", () => {
  const report = buildReport({ dir: loneDir, builtins: ["scout"] });
  const text = formatReport(report);
  const json = JSON.stringify(report);
  assert.match(text, /scout/);
  assert.match(text, /1/);
  assert.match(text, /lossy handoff/i);
  assert.match(text, /fold candidate/i);
  assert.match(text, /fan-out/i);
  for (const output of [text, json]) {
    assert.equal(output.includes(SENTINEL), false);
    assert.equal(output.includes("secret"), false);
    assert.equal(output.includes("/tmp/proj"), false);
    assert.equal(output.includes("only-grep"), false);
  }
});

function treeSnapshot(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(`${full}:${fs.statSync(full).mtimeMs}:${fs.statSync(full).size}`);
    }
  };
  walk(dir);
  return out.sort();
}

test("the cli text and --json never print the sentinel and never write sessions", () => {
  const before = treeSnapshot(fixtureRoot);
  for (const args of [[], ["--json"]]) {
    const result = spawnSync(process.execPath, [reportScript, "--sessions", loneDir, ...args], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(output.includes(SENTINEL), false);
    assert.equal(output.includes("secret"), false);
    assert.equal(output.includes("/tmp/proj"), false);
    assert.match(result.stdout, /reviewer/);
    assert.match(result.stdout, /verifier/);
  }
  assert.deepEqual(treeSnapshot(fixtureRoot), before);
});

function cliReport(args) {
  const result = spawnSync(
    process.execPath,
    [reportScript, "--json", "--sessions", fixtureRoot, ...args],
    {
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(`${result.stdout}${result.stderr}`.includes(SENTINEL), false);
  return JSON.parse(result.stdout);
}

test("a preflight rejection is not a spawn and a failed ledger outcome is not a label", () => {
  const report = buildReport({ dir: rejectDir, builtins: ["scout", "worker", "reviewer"] });
  assert.equal(report.spawns, 1);
  assert.equal(report.types.find((row) => row.type === "scout").spawns, 0);
  assert.equal(report.types.find((row) => row.type === "worker").spawns, 0);
  const reviewer = report.types.find((row) => row.type === "reviewer");
  assert.equal(reviewer.spawns, 1);
  assert.equal(reviewer.triage.blocked, 0);
  assert.equal(JSON.stringify(report).includes(SENTINEL), false);
});

test("--since and --limit keep the newest matching sessions", () => {
  const since = cliReport(["--since", "2026-10-20"]);
  assert.equal(since.spawns, 1);
  assert.equal(since.types.find((row) => row.type === "worker").spawns, 0);

  const limited = cliReport(["--limit", "1"]);
  assert.equal(limited.sessions, 1);
  assert.equal(limited.spawns, 1);

  const both = cliReport(["--since", "2026-10-19", "--limit", "1"]);
  assert.equal(both.sessions, 1);
  assert.equal(both.types.find((row) => row.type === "worker").spawns, 0);
});
