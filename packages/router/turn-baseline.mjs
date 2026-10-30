// turn-baseline.mjs — per-repository good-turn length baselines for stuck detection.
//
// Stored under the agent directory. No model calls: counts and medians only.

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { agentDir } from "./config.mjs";
import { flagOff } from "../../shared/env-flag.mjs";
import {
  STUCK_BASELINE_MAX_GOOD_TURNS,
  STUCK_BASELINE_MIN_GOOD_TURNS,
  STUCK_LENGTH_MULTIPLIER,
  STUCK_MIN_FAILURES,
} from "./lib.mjs";
import { turnsFromMessages, WINDOW } from "./model-battery.mjs";

const BASELINE_FILE = "router-turn-baseline.json";

export function baselinePath(env = process.env) {
  return path.join(agentDir(env), BASELINE_FILE);
}

/** Stable key for a repository: git root, or normalised cwd when git is unavailable. */
export function formatRepoKey(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return "";
  return path.resolve(text).replace(/\/+$/, "") || "/";
}

export function gitRepoKey(cwd, env = process.env) {
  const dir = String(cwd ?? env?.PWD ?? process.cwd()).trim() || process.cwd();
  try {
    const out = execSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return formatRepoKey(out.trim());
  } catch {
    return formatRepoKey(dir);
  }
}

export function readBaselineStore(file = baselinePath()) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { repos: {} };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { repos: {} };
    const repos = parsed.repos;
    if (!repos || typeof repos !== "object" || Array.isArray(repos)) return { repos: {} };
    const out = {};
    for (const [key, value] of Object.entries(repos)) {
      if (!Array.isArray(value)) continue;
      const lengths = value
        .map((n) => Number(n))
        .filter((n) => Number.isFinite(n) && n >= 0)
        .slice(-STUCK_BASELINE_MAX_GOOD_TURNS);
      if (lengths.length) out[formatRepoKey(key)] = lengths;
    }
    return { repos: out };
  } catch {
    return { repos: {} };
  }
}

export function writeBaselineStoreAtomic(file, store) {
  const payload = `${JSON.stringify(store, null, 2)}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, payload, "utf8");
  fs.renameSync(tmp, file);
}

export function turnEndedWell(turn) {
  const calls = turn?.toolCalls ?? [];
  if (!calls.length) return true;
  return !calls[calls.length - 1]?.isError;
}

export function recordGoodTurnLength(file, repoKey, toolCallCount) {
  const key = formatRepoKey(repoKey);
  if (!key) return;
  const count = Number(toolCallCount);
  if (!Number.isFinite(count) || count < 0) return;
  const store = readBaselineStore(file);
  const list = [...(store.repos[key] ?? []), Math.trunc(count)];
  store.repos[key] = list.slice(-STUCK_BASELINE_MAX_GOOD_TURNS);
  writeBaselineStoreAtomic(file, store);
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function stuckBaselineEnabled(env = process.env) {
  return !flagOff(env?.PI_ROUTER_STUCK_BASELINE);
}

/**
 * Pure snapshot from recorded good-turn lengths and env. Used by isStuckTurn and /route preview.
 */
export function stuckBaselineSnapshot(lengths, env = process.env) {
  const goodTurns = (lengths ?? []).filter((n) => Number.isFinite(n) && n >= 0);
  const goodTurnCount = goodTurns.length;
  const medianToolCalls = goodTurnCount ? median(goodTurns) : 0;
  const enabled = stuckBaselineEnabled(env);
  const adaptive = enabled && goodTurnCount >= STUCK_BASELINE_MIN_GOOD_TURNS;
  const toolCallThreshold = adaptive
    ? Math.max(STUCK_MIN_FAILURES, Math.ceil(STUCK_LENGTH_MULTIPLIER * medianToolCalls))
    : STUCK_MIN_FAILURES;
  return {
    enabled,
    adaptive,
    goodTurnCount,
    medianToolCalls,
    toolCallThreshold,
  };
}

export function stuckBaselineForRepo(file, repoKey, env = process.env) {
  const store = readBaselineStore(file);
  const key = formatRepoKey(repoKey);
  const lengths = store.repos[key] ?? [];
  return stuckBaselineSnapshot(lengths, env);
}

export function recordCompletedTurnBaseline({ file, cwd, messages, env = process.env }) {
  if (!stuckBaselineEnabled(env)) return;
  const repoKey = gitRepoKey(cwd, env);
  const turns = turnsFromMessages(messages, WINDOW + 50);
  const completed = turns[turns.length - 1];
  if (!completed || !turnEndedWell(completed)) return;
  recordGoodTurnLength(file, repoKey, (completed.toolCalls ?? []).length);
}
