// systemone-config.mjs — where the endpoint and key come from, and the defaults
// both transports share. One of five files split from systemone.mjs; the request
// contract lives in systemone-request.mjs.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const DEFAULT_BASE_URL = "https://api.typesafe.ai/v1";

// Pinned, not `jev-latest`: the guardrail, router, safe-compact and scripts/
// thresholds were measured on this version, and TypeSafe says to send a
// versioned ID once thresholds are tuned. Re-run scripts/judge-thresholds.mjs
// and scripts/replay-corpus.mjs on a new version before moving this pin.
export const DEFAULT_MODEL = "jev-1.13.0";

const DEFAULT_TIMEOUT_MS = 30000;

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizeBaseUrl(value) {
  const raw = String(value ?? "").trim() || DEFAULT_BASE_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`TYPESAFE_BASE_URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("TYPESAFE_BASE_URL must use http or https");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

/**
 * Candidate lore config paths, mirroring lore's own resolver
 * (lib/core/lore-paths.mjs): LORE_CONFIG, then LORE_HOME or
 * XDG_CONFIG_HOME/lore, with the legacy ~/.copilot fallback kept for installs
 * that have not been migrated.
 */
function loreConfigPaths(env) {
  const explicitConfig = typeof env?.LORE_CONFIG === "string" ? env.LORE_CONFIG.trim() : "";
  if (explicitConfig) {
    // An explicit override means that file, exactly as lore treats it: no
    // silent fallback that could authenticate with something else.
    return [explicitConfig];
  }
  const home = typeof env?.HOME === "string" && env.HOME.trim() ? env.HOME.trim() : homedir();
  const copilotHome =
    typeof env?.LORE_COPILOT_HOME === "string" && env.LORE_COPILOT_HOME.trim()
      ? env.LORE_COPILOT_HOME.trim()
      : join(home, ".copilot");
  const xdgHome = typeof env?.XDG_CONFIG_HOME === "string" ? env.XDG_CONFIG_HOME.trim() : "";
  const configHome = xdgHome && isAbsolute(xdgHome) ? xdgHome : join(home, ".config");
  const explicitHome = typeof env?.LORE_HOME === "string" ? env.LORE_HOME.trim() : "";
  const preferredHome = explicitHome || join(configHome, "lore");
  const preferredConfig = join(preferredHome, "lore.json");
  // lore only reads the pre-migration home while nothing has been migrated, so
  // a stale legacy key cannot shadow the current config.
  const legacy = !explicitHome && !existsSync(preferredConfig);
  return legacy ? [preferredConfig, join(copilotHome, "lore.json")] : [preferredConfig];
}

/**
 * Last-resort key source: the lore config. Returns the paths checked and any
 * parse failure so the caller can say what it looked at instead of blaming the
 * environment for a config typo.
 */
function apiKeySources(env) {
  const checked = loreConfigPaths(env);
  let parseError = null;
  for (const configPath of checked) {
    let raw;
    try {
      raw = readFileSync(configPath, "utf8");
    } catch {
      continue; // absent or unreadable: keep looking
    }
    try {
      const key = JSON.parse(raw)?.typesafe?.apiKey;
      if (typeof key === "string" && key.trim()) {
        return { key: key.trim(), checked, parseError };
      }
    } catch (error) {
      parseError = `${configPath}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return { key: "", checked, parseError };
}

/**
 * The shared TypeSafe key, in precedence order: TYPESAFE_API_KEY, then
 * LORE_TYPESAFE_API_KEY, then the lore config file. Never throws.
 */
export function resolveApiKey(env = process.env) {
  const primaryKey = typeof env?.TYPESAFE_API_KEY === "string" ? env.TYPESAFE_API_KEY.trim() : "";
  const loreKey =
    typeof env?.LORE_TYPESAFE_API_KEY === "string" ? env.LORE_TYPESAFE_API_KEY.trim() : "";
  return primaryKey || loreKey || apiKeySources(env).key;
}

/** Resolve runtime configuration from the environment. */
export function resolveConfig(env = process.env) {
  const model = typeof env?.TYPESAFE_MODEL === "string" ? env.TYPESAFE_MODEL.trim() : "";
  return {
    apiKey: resolveApiKey(env),
    baseUrl: normalizeBaseUrl(env?.TYPESAFE_BASE_URL),
    model: model || DEFAULT_MODEL,
    timeoutMs: positiveInteger(env?.TYPESAFE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
}

export function missingKeyError(env) {
  const sources = apiKeySources(env);
  const detail = sources.parseError ? ` (unreadable config: ${sources.parseError})` : "";
  return new Error(
    `TYPESAFE_API_KEY is not set. Set it in the environment or as typesafe.apiKey in ${sources.checked.join(" or ")}${detail}.`,
  );
}

/** An explicit base URL (proxy, smoke fixture). Unset keeps the catalog host. */
export function configuredBaseUrl(env, config) {
  const raw = typeof env?.TYPESAFE_BASE_URL === "string" ? env.TYPESAFE_BASE_URL.trim() : "";
  return raw ? config.baseUrl : null;
}
