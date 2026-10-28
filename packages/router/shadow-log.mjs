// shadow-log.mjs — local JSONL of what router/auto would have chosen.
//
// Append-only under the agent directory. No prompt text — only a short hash for
// de-duplication. The report helpers are pure so scripts and tests share them.

import crypto from "node:crypto";
import fs from "node:fs";

import { agentDir } from "./config.mjs";

const LOG_FILE = "router-shadow.jsonl";

export function shadowLogPath(env = process.env) {
  return `${agentDir(env)}/${LOG_FILE}`;
}

/** Stable, short hash of the prompt for de-duplication — not reversible. */
export function promptHash(prompt) {
  return crypto
    .createHash("sha256")
    .update(String(prompt ?? ""))
    .digest("hex")
    .slice(0, 12);
}

export function appendShadowLine(file, entry) {
  fs.mkdirSync(agentDirFromFile(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
}

function agentDirFromFile(file) {
  const idx = file.lastIndexOf("/");
  return idx >= 0 ? file.slice(0, idx) : ".";
}

export function readShadowLines(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const lines = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      lines.push(JSON.parse(trimmed));
    } catch {
      // Skip corrupted lines; the report is best-effort.
    }
  }
  return lines;
}

function pairKey(actual) {
  if (!actual?.key) return "";
  const thinking = actual.thinking ?? "";
  return `${actual.key}@${thinking}`;
}

/**
 * @param {Array<{ actual?: { key?: string, thinking?: string }, wouldBe?: { tier?: string, key?: string, thinking?: string } }>} lines
 */
export function summarizeShadowLog(lines) {
  const wouldBeTier = { base: 0, mid: 0, frontier: 0 };
  let sameModel = 0;
  let differentModel = 0;
  for (const line of lines) {
    const tier = line?.wouldBe?.tier;
    if (tier === "base" || tier === "mid" || tier === "frontier") wouldBeTier[tier]++;
    const actual = pairKey(line?.actual);
    const would = pairKey(line?.wouldBe);
    if (actual && would) {
      if (actual === would) sameModel++;
      else differentModel++;
    }
  }
  return {
    turns: lines.length,
    wouldBeTier,
    sameModel,
    differentModel,
  };
}

export function formatShadowReport(summary) {
  const { turns, wouldBeTier, sameModel, differentModel } = summary;
  if (!turns) return "shadow log: no turns recorded";
  const pct = (n) => `${Math.round((n / turns) * 100)}%`;
  return [
    `shadow log: ${turns} turn${turns === 1 ? "" : "s"}`,
    `would-be tier base ${wouldBeTier.base} (${pct(wouldBeTier.base)}) · mid ${wouldBeTier.mid} (${pct(wouldBeTier.mid)}) · frontier ${wouldBeTier.frontier} (${pct(wouldBeTier.frontier)})`,
    `same model as actual ${sameModel} · different ${differentModel}`,
  ].join("\n");
}
