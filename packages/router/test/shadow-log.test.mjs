// Shadow log JSONL helpers and the offline report — no pi host, no network.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  appendShadowLine,
  promptHash,
  readShadowLines,
  shadowLogPath,
  summarizeShadowLog,
} from "../shadow-log.mjs";

const tempDirs = [];

function tempLog(initialLines = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "router-shadow-"));
  tempDirs.push(dir);
  const file = path.join(dir, "router-shadow.jsonl");
  for (const line of initialLines) appendShadowLine(file, line);
  return file;
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test("shadow log path lives under the agent directory", () => {
  assert.equal(
    shadowLogPath({ PI_CODING_AGENT_DIR: "/tmp/agent" }),
    "/tmp/agent/router-shadow.jsonl",
  );
});

test("a log line has the required fields and no prompt text", () => {
  const file = tempLog();
  const entry = {
    at: 1_700_000_000_000,
    sessionId: "sess-1",
    actual: { key: "openai-codex/gpt-5.6-luna", thinking: "medium" },
    wouldBe: { tier: "frontier", key: "openai-codex/gpt-6-astra", thinking: "medium" },
    difficulty: 2.6,
    gateReason: "first turn",
    decisionReason: "escalated",
    promptHash: promptHash("audit the routing design"),
  };
  appendShadowLine(file, entry);
  const raw = fs.readFileSync(file, "utf8").trim();
  assert.ok(!raw.includes("audit the routing design"));
  const parsed = JSON.parse(raw);
  assert.equal(parsed.sessionId, "sess-1");
  assert.equal(parsed.actual.key, "openai-codex/gpt-5.6-luna");
  assert.equal(parsed.wouldBe.tier, "frontier");
  assert.equal(parsed.difficulty, 2.6);
  assert.equal(parsed.gateReason, "first turn");
  assert.equal(parsed.decisionReason, "escalated");
  assert.equal(typeof parsed.promptHash, "string");
  assert.ok(parsed.promptHash.length >= 8);
});

test("summarizeShadowLog counts tiers and model differences", () => {
  const lines = [
    {
      actual: { key: "openai-codex/gpt-5.6-luna", thinking: "medium" },
      wouldBe: { tier: "base", key: "openai-codex/gpt-5.6-luna", thinking: "medium" },
    },
    {
      actual: { key: "openai-codex/gpt-5.6-luna", thinking: "medium" },
      wouldBe: { tier: "mid", key: "openai-codex/gpt-6-astra", thinking: "low" },
    },
    {
      actual: { key: "openai-codex/gpt-5.6-luna", thinking: "medium" },
      wouldBe: { tier: "frontier", key: "openai-codex/gpt-6-astra", thinking: "medium" },
    },
    {
      actual: { key: "openai-codex/gpt-6-astra", thinking: "medium" },
      wouldBe: { tier: "frontier", key: "openai-codex/gpt-6-astra", thinking: "medium" },
    },
  ];
  const summary = summarizeShadowLog(lines);
  assert.equal(summary.turns, 4);
  assert.equal(summary.wouldBeTier.base, 1);
  assert.equal(summary.wouldBeTier.mid, 1);
  assert.equal(summary.wouldBeTier.frontier, 2);
  assert.equal(summary.sameModel, 2);
  assert.equal(summary.differentModel, 2);
});

test("readShadowLines skips blank lines and broken JSON", () => {
  const file = tempLog();
  fs.appendFileSync(
    file,
    '{"actual":{"key":"a","thinking":"medium"},"wouldBe":{"tier":"base","key":"a","thinking":"medium"}}\n\nnot json\n',
  );
  const lines = readShadowLines(file);
  assert.equal(lines.length, 1);
});
