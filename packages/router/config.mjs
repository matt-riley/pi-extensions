// config.mjs — where the router's model/reasoning pairs live.
//
// They were environment variables, which made every change a restart and hid
// the built-in defaults from view. They are now a JSON file in the agent
// directory, seeded with defaults on first load and re-read on each judgement,
// so an edit takes effect at the next task without restarting pi.
//
// Each tier is a preference-ordered list of pairs. Legacy strings remain valid
// and mean "this model at the caller's selected level"; objects make the pair
// explicit, which is what lets Sol@xhigh beat Astra@low when the cap allows it.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DEFAULT_BASE_PATTERNS, DEFAULT_FRONTIER_PATTERNS } from "./model-battery.mjs";

const CONFIG_FILE = "router.json";

/** The agent directory pi uses, read without importing the SDK at runtime. */
export function agentDir(env = process.env) {
  const override = String(env?.PI_CODING_AGENT_DIR ?? "").trim();
  return override || path.join(os.homedir(), ".pi", "agent");
}

export function routerConfigPath(env = process.env) {
  return path.join(agentDir(env), CONFIG_FILE);
}

const pair = (model, thinking) => ({
  model,
  ...(thinking ? { thinking } : {}),
});

/** The pairs written to a fresh config file. Stronger pairs come first. */
export const DEFAULT_CONFIG = {
  base: [pair(DEFAULT_BASE_PATTERNS[0], "medium"), pair(DEFAULT_BASE_PATTERNS[0])],
  mid: [pair(DEFAULT_FRONTIER_PATTERNS[0], "low"), pair(DEFAULT_BASE_PATTERNS[0], "xhigh")],
  frontier: [
    pair(DEFAULT_FRONTIER_PATTERNS[1], "max"),
    pair(DEFAULT_FRONTIER_PATTERNS[1], "xhigh"),
    pair(DEFAULT_FRONTIER_PATTERNS[0], "medium"),
    pair(DEFAULT_FRONTIER_PATTERNS[0], "low"),
    pair(DEFAULT_FRONTIER_PATTERNS[2], "medium"),
    pair(DEFAULT_FRONTIER_PATTERNS[3], "medium"),
    pair(DEFAULT_FRONTIER_PATTERNS[4], "medium"),
  ],
};

function pairOf(entry) {
  if (typeof entry === "string") {
    const model = entry.trim();
    return model ? pair(model) : null;
  }
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;
  const model = String(entry.model ?? entry.pattern ?? "").trim();
  if (!model) return null;
  const thinking = String(entry.thinking ?? entry.thinkingLevel ?? "")
    .trim()
    .toLowerCase();
  return pair(model, thinking || undefined);
}

/** A string or pair array, with blanks and malformed entries dropped. */
function patternsOf(value) {
  const list = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  return list.map(pairOf).filter(Boolean);
}

function defaults() {
  return {
    base: DEFAULT_CONFIG.base.map((entry) => ({ ...entry })),
    mid: DEFAULT_CONFIG.mid.map((entry) => ({ ...entry })),
    frontier: DEFAULT_CONFIG.frontier.map((entry) => ({ ...entry })),
  };
}

/**
 * Read the model/reasoning pairs.
 *
 * A missing key falls back to the built-in default; an explicit empty list
 * stays empty, because that is a decision rather than a typo. `error` is
 * returned rather than thrown so a broken file narrows routing instead of
 * breaking the session.
 */
export function readRouterConfig(file = routerConfigPath()) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { ...defaults(), shadowLog: false, error: null };
    return {
      ...defaults(),
      shadowLog: false,
      error: `could not read ${file}: ${error?.message ?? error}`,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ...defaults(),
      shadowLog: false,
      error: `${file} is not valid JSON: ${error?.message ?? error}`,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ...defaults(),
      shadowLog: false,
      error: `${file} must be a JSON object like {"base": "..."}`,
    };
  }

  const out = { ...defaults(), shadowLog: false, error: null };
  for (const key of ["base", "mid", "frontier"]) {
    if (key in parsed) out[key] = patternsOf(parsed[key]);
  }
  if ("shadowLog" in parsed) {
    const flag = parsed.shadowLog;
    out.shadowLog = flag === true || String(flag).trim().toLowerCase() === "true";
  }
  return out;
}

/** Merge `shadowLog` into router.json without touching tier lists. */
export function writeShadowLogFlag(file, enabled) {
  let parsed = {};
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    parsed = { ...DEFAULT_CONFIG };
  parsed.shadowLog = Boolean(enabled);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

/**
 * Configured patterns that match no offered model, by the same
 * case-insensitive substring rule the tiers use. A stale entry is otherwise
 * skipped in silence, and the tier quietly falls through to its next pair.
 */
export function unmatchedPatterns(tiers, offerKeys) {
  const keys = offerKeys.map((key) => String(key).toLowerCase());
  const missing = new Set();
  for (const tier of ["base", "mid", "frontier"])
    for (const { model } of tiers?.[tier] ?? [])
      if (!keys.some((key) => key.includes(model.toLowerCase()))) missing.add(model);
  return [...missing];
}

/**
 * Write the default pairs if the file does not exist yet, so there is always
 * something to open and edit. Never overwrites: `wx` fails if the file appeared
 * between the read and the write.
 */
export function ensureRouterConfig(file = routerConfigPath()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    return true;
  } catch {
    return false;
  }
}
