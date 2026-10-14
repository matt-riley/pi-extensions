#!/usr/bin/env node
// judge-live.mjs — labelled cases for the failure triage and the ask gate.
//
// Both run against the live judge, so this measures judgement rather than
// wiring: the unit tests prove the requests are well formed and the mapping is
// right, and only a live run says whether the questions land. Report-only for
// the labels (a model's reading is a hypothesis), non-zero for the contract: an
// unavailable judge, or a case that produced nothing where something was owed.
//
//   node scripts/judge-live.mjs

import { judgeFailure, triageText } from "../packages/diagnosis-nudge/triage.mjs";
import { decideGate, judgeQuestion } from "../packages/plan-mode/ask-gate.mjs";

const pieces = (...parts) => parts.join("");

const FAILURES = [
  {
    name: "port already in use",
    expect: "environment",
    action: "pnpm dev",
    output: "Error: listen EADDRINUSE: address already in use :::3000",
  },
  {
    name: "failing assertion",
    expect: "code_bug",
    action: "pnpm test",
    output: [
      "FAIL packages/guardrail/test/judge.test.mjs > destructive but scoped asks the human",
      "AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:",
      "  actual: 'confirm',",
      "  expected: 'allow',",
      "Test Files  1 failed | 21 passed (22)",
    ].join("\n"),
  },
  {
    name: "connection refused",
    expect: "transient or environment",
    action: "curl -sS http://localhost:8080/health",
    output:
      "curl: (7) Failed to connect to localhost port 8080 after 0 ms: Couldn't connect to server",
  },
  {
    name: "token on stdout",
    expect: "leak",
    action: "env | grep -i token",
    output: pieces("GITHUB_TOKEN=ghp_", "abcdefghijklmnopqrstuvwxyz0123456789"),
  },
];

const QUESTIONS = [
  {
    name: "package manager, inferable",
    expect: "answer",
    question: "Which package manager should I use for zod?",
    options: ["pnpm", "npm"],
    recommended: "pnpm",
    request: "add zod validation to the loaders",
  },
  {
    name: "delete old files",
    expect: "ask (deterministic veto)",
    question: "Should I delete the old migration files?",
    options: ["Delete them", "Keep them"],
    recommended: "Keep them",
    request: "tidy up the migrations directory",
  },
  {
    name: "module shape, inferable",
    expect: "answer",
    question: "Should the new parser be a .mjs module or part of the entrypoint?",
    options: ["A plain .mjs module", "In index.ts"],
    recommended: "A plain .mjs module",
    request: "add a parser for the check output",
  },
  {
    name: "colour, a preference",
    expect: "ask (deterministic veto)",
    question: "Which colour should the status badge be?",
    options: ["Green", "Blue"],
    recommended: "Green",
    request: "add a status badge to the footer",
  },
];

let broken = 0;
console.log("failure triage");
for (const item of FAILURES) {
  const judged = await judgeFailure(item);
  const line = triageText(judged);
  if (judged.unavailable) broken += 1;
  console.log(`  ${item.name}`);
  console.log(`    expect ${item.expect}`);
  console.log(
    `    judged ${judged.failureClass ?? "(none)"} p=${judged.confidence ?? "-"} leak=${judged.leaksSecret ?? "-"}`,
  );
  console.log(`    line   ${line ?? "(nothing)"}`);
}

console.log("\nask gate");
for (const item of QUESTIONS) {
  const judged = await judgeQuestion(item);
  const decision = decideGate(item, judged);
  if (judged.unavailable) broken += 1;
  console.log(`  ${item.name}`);
  console.log(`    expect ${item.expect}`);
  console.log(
    `    judged pick=${judged.pick ?? "(none)"} p=${judged.confidence ?? "-"} determined=${judged.determined ?? "-"}`,
  );
  console.log(
    `    gate   ${decision.answer ? `answer "${decision.answer}" — ${decision.reason}` : `ask the user — ${decision.reason}`}`,
  );
}

console.log(
  broken === 0 ? "\njudge reachable for every case" : `\n${broken} case(s) had no judgment`,
);
process.exitCode = broken === 0 ? 0 : 1;
