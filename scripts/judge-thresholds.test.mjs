import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import * as judge from "../packages/guardrail/judge.mjs";
import * as ledger from "../shared/jev-ledger.mjs";
import { TUNED_MODEL } from "../shared/jev-ledger.mjs";
import { CURRENT, answersOf, scoreCandidate, scoreable } from "./judge-thresholds.mjs";

const { routeVerdict } = judge;

const noul = (value) => ({ type: "noul", noul: value });
const score = (value) => ({ type: "score", score: value });

test("the measured thresholds cannot be re-tuned at runtime", () => {
  assert.equal(Object.isFrozen(judge.THRESHOLDS), true);
  assert.throws(() => {
    judge.THRESHOLDS.destructive = 0.1;
  });
  assert.equal(judge.THRESHOLDS.destructive, 0.5);
});

test("the measured thresholds record the Jev they were tuned on", () => {
  assert.equal(TUNED_MODEL, "jev-1.13.0");
  assert.equal(judge.THRESHOLDS?.tunedModel, TUNED_MODEL);
  assert.equal(CURRENT.tunedModel, TUNED_MODEL);
  assert.equal(judge.THRESHOLDS?.intentMismatch, 0.85);
  assert.equal(judge.THRESHOLDS?.destructive, 0.5);
  assert.equal(judge.THRESHOLDS?.credentials, 0.6);
  assert.equal(judge.THRESHOLDS?.blastRadius, 2);
  assert.equal(CURRENT.destructive, 0.5);
  assert.equal(CURRENT.intentMismatch, 0.6);
});

test("guardrail ledger entries export as replay-corpus records without the action", () => {
  assert.equal(typeof ledger.toReplayCorpus, "function");
  const secret = "SECRET-STATE-do-not-export";
  const corpus = ledger.toReplayCorpus([
    {
      feature: "guardrail",
      outcome: "ok",
      answers: {
        destructive: { type: "noul", noul: 0.2 },
        intent_mismatch: { type: "noul", noul: 0.9 },
        credentials: { type: "noul", noul: 0.1 },
        blast_radius: { type: "score", score: 1 },
      },
      state: { command: secret },
    },
    {
      type: "custom",
      customType: "jev-decision",
      data: {
        feature: "skill-select",
        outcome: "ok",
        transport: "http",
        answers: { best: { type: "choice", choice: "grill-me" } },
        state: secret,
      },
    },
    { type: "custom", customType: "router-decision", data: { state: secret } },
    null,
  ]);
  assert.equal(corpus.sampled, 1);
  assert.equal(corpus.records.length, 1);
  assert.equal(corpus.records[0].action, "(not recorded)");
  assert.equal(corpus.records[0].signals.intent_mismatch, 0.9);
  assert.equal(corpus.records[0].signals.destructive, 0.2);
  assert.equal(JSON.stringify(corpus).includes(secret), false, "state reached the corpus");
  const scored = scoreCandidate(corpus.records, {
    destructive: 0.5,
    intentMismatch: 0.85,
    credentials: 0.6,
    blastRadius: 2,
  });
  assert.equal(scored.judged, 1);
  assert.equal(scored.counts.confirm, 1);
});

test("replay export excludes unrelated and unattributed judgments with colliding question ids", () => {
  const guardrail = {
    feature: "guardrail",
    outcome: "ok",
    answers: { credentials: { type: "noul", noul: 0.1 } },
  };
  const entries = [guardrail];
  for (const feature of ["typesafe", "skill-select", "unknown", undefined]) {
    const data = {
      feature,
      outcome: "ok",
      answers: { credentials: { type: "noul", noul: 0.9 } },
    };
    entries.push(data, { type: "custom", customType: "jev-decision", data });
  }
  entries.push({ ...guardrail, outcome: "error" });
  const corpus = ledger.toReplayCorpus(entries);
  assert.equal(corpus.sampled, 1);
  assert.equal(corpus.records.length, 1);
  assert.deepEqual(corpus.records[0].signals, { credentials: 0.1 });
});

test("an exported replay record names the ledger as its source", () => {
  const corpus = ledger.toReplayCorpus([
    {
      type: "custom",
      customType: "jev-decision",
      data: {
        feature: "guardrail",
        outcome: "ok",
        answers: { destructive: { type: "noul", noul: 0.2 } },
      },
    },
  ]);
  assert.equal(corpus.records.length, 1);
  assert.equal(corpus.records[0].source, "ledger");
  assert.equal(corpus.records[0].action, "(not recorded)");
  assert.equal(corpus.records[0].verdict, null);
  assert.equal(corpus.records[0].reason, null);
});

test("answersOf rebuilds the router's own input from its signals", () => {
  // Every branch, so a missing one cannot hide behind a happy path.
  const cases = [
    { destructive: 0.6, intent_mismatch: 0.9, credentials: 0.1, blast_radius: 2 },
    { destructive: 0.0, intent_mismatch: 0.0, credentials: 0.0, blast_radius: 0 },
    { destructive: 0.72, blast_radius: 3 },
    { credentials: 0.95 },
  ];
  let checked = 0;
  for (const signals of cases) {
    const direct = routeVerdict({
      destructive: noul(signals.destructive ?? 0.3),
      intent_mismatch: noul(signals.intent_mismatch ?? 0.2),
      credentials: noul(signals.credentials ?? 0.02),
      blast_radius: score(signals.blast_radius ?? 0.9),
    });
    const rebuilt = routeVerdict(answersOf(direct.signals));
    assert.equal(rebuilt.verdict, direct.verdict, JSON.stringify(signals));
    assert.deepEqual(rebuilt.signals, direct.signals);
    checked += 1;
  }
  assert.equal(checked, cases.length);
});

test("a record with no signals is a hole, never a verdict", () => {
  assert.equal(scoreable({ signals: {} }), false);
  assert.equal(scoreable({ signals: null }), false);
  assert.equal(scoreable({}), false);
  // routeVerdict says the same about empty answers: no verdict, not allow.
  assert.equal(routeVerdict({}).verdict, null);

  const { judged, counts } = scoreCandidate(
    [
      { signals: null, action: "rm -rf /" },
      { signals: { intent_mismatch: 0.99 }, action: "x" },
    ],
    { destructive: 0.5, intentMismatch: 0.6, credentials: 0.6, blastRadius: 2 },
  );
  assert.equal(judged, 1);
  assert.deepEqual(counts, { allow: 0, confirm: 1, block: 0 });
});

test("loosening a line can only move calls from confirm to allow", () => {
  const records = [
    { signals: { intent_mismatch: 0.65 }, action: "go test -race ./..." },
    { signals: { intent_mismatch: 0.9 }, action: "rm -rf .pi" },
    { signals: { destructive: 0.8, blast_radius: 2 }, action: "shred ~/.ssh/id_rsa" },
    { signals: { credentials: 0.7, blast_radius: 1 }, action: "cat ~/.aws/credentials" },
  ];
  const strict = { destructive: 0.5, intentMismatch: 0.6, credentials: 0.6, blastRadius: 2 };
  const loose = { ...strict, intentMismatch: 0.85 };
  const a = scoreCandidate(records, strict);
  const b = scoreCandidate(records, loose);

  assert.equal(b.counts.allow, a.counts.allow + 1, "only the 0.65 intent call clears");
  assert.equal(b.counts.confirm, a.counts.confirm - 1);
  assert.equal(b.counts.block, a.counts.block, "blocking is not threshold-driven here");
  assert.deepEqual(b.newlyAllowed, ["go test -race ./..."]);
});

test("judge-thresholds --show-allow says when the action was not recorded", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-allow-"));
  const file = path.join(dir, "sample.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      records: [
        { signals: { intent_mismatch: 0.65 }, action: "(not recorded)" },
        { signals: { intent_mismatch: 0.65 }, action: null },
        { signals: { intent_mismatch: 0.65 } },
        { signals: { intent_mismatch: 0.65 }, action: "go test -race ./..." },
      ],
    }),
  );
  const result = spawnSync(
    process.execPath,
    ["scripts/judge-thresholds.mjs", file, "--show-allow"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /action wasn't recorded/);
  assert.equal(result.stdout.includes("(not recorded)"), false);
  assert.equal(/\bnull\b/.test(result.stdout), false);
  assert.equal(/\bundefined\b/.test(result.stdout), false);
  assert.match(result.stdout, /go test -race/);
});

test("judge-thresholds --show-allow counts unrecorded actions on one line", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jev-allow-"));
  const file = path.join(dir, "sample.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      records: [
        { signals: { intent_mismatch: 0.65 }, action: "(not recorded)" },
        { signals: { intent_mismatch: 0.65 }, action: null },
        { signals: { intent_mismatch: 0.65 } },
        { signals: { intent_mismatch: 0.65 }, action: "go test -race ./..." },
      ],
    }),
  );
  const result = spawnSync(
    process.execPath,
    ["scripts/judge-thresholds.mjs", file, "--show-allow"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.split("\n").filter((line) => line.includes("action wasn't recorded"));
  assert.deepEqual(lines, [
    "    action wasn't recorded for 3 records",
    "    action wasn't recorded for 3 records",
    "    action wasn't recorded for 3 records",
    "    action wasn't recorded for 3 records",
  ]);
});
