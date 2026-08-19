// settings.mjs — webFetch* defaults from settings files.
//
// Sources, in increasing precedence: built-in defaults <
// ~/.pi/agent/settings.json < <cwd>/.pi/settings.json. Supports both flat
// `webFetchDefaultFormat` keys and a nested `webFetch: { ... }` object.

import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const FORMATS = ["markdown", "html", "text", "json", "raw"];

export const DEFAULT_SETTINGS = {
  defaultFormat: "markdown",
  defaultMaxChars: 60000,
  defaultTimeoutMs: 15000,
  batchConcurrency: 4,
  userAgent: "",
  extraHeaders: {},
  followAlternates: true,
  includeImages: false,
  useGh: true,
  searxngUrl: "",
};

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function pickFormat(value) {
  return typeof value === "string" && FORMATS.includes(value) ? value : undefined;
}

// Pulls webFetch* keys out of a settings object (flat or nested).
function pickSettings(raw) {
  if (!raw || typeof raw !== "object") return {};
  const src = {};
  const nested = raw.webFetch;
  if (nested && typeof nested === "object") {
    for (const [k, v] of Object.entries(nested)) src[k] = v;
  }
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith("webFetch")) src[k.slice("webFetch".length)] = v;
  }
  return src;
}

export function sanitizeSettings(raw) {
  const src = pickSettings(raw);
  const out = {};

  const format = pickFormat(src.DefaultFormat ?? src.defaultFormat);
  if (format) out.defaultFormat = format;

  const maxChars = clampInt(src.DefaultMaxChars ?? src.defaultMaxChars, 1000, 1_000_000, undefined);
  if (maxChars !== undefined) out.defaultMaxChars = maxChars;

  const timeout = clampInt(src.DefaultTimeoutMs ?? src.defaultTimeoutMs, 1000, 120_000, undefined);
  if (timeout !== undefined) out.defaultTimeoutMs = timeout;

  const concurrency = clampInt(src.BatchConcurrency ?? src.batchConcurrency, 1, 10, undefined);
  if (concurrency !== undefined) out.batchConcurrency = concurrency;

  if (typeof (src.UserAgent ?? src.userAgent) === "string") out.userAgent = src.UserAgent ?? src.userAgent;

  const extra = src.ExtraHeaders ?? src.extraHeaders;
  if (extra && typeof extra === "object" && !Array.isArray(extra)) {
    const clean = {};
    for (const [k, v] of Object.entries(extra)) {
      if (typeof v === "string" || typeof v === "number") clean[k] = String(v);
    }
    if (Object.keys(clean).length) out.extraHeaders = clean;
  }

  const bool = (key) => {
    const v = src[key];
    if (v === true || v === "true") return true;
    if (v === false || v === "false") return false;
    return undefined;
  };
  const follow = bool("FollowAlternates") ?? bool("followAlternates");
  if (follow !== undefined) out.followAlternates = follow;
  const images = bool("IncludeImages") ?? bool("includeImages");
  if (images !== undefined) out.includeImages = images;
  const gh = bool("UseGh") ?? bool("useGh");
  if (gh !== undefined) out.useGh = gh;

  const searxng = src.SearxngUrl ?? src.searxngUrl;
  if (typeof searxng === "string" && searxng.trim()) out.searxngUrl = searxng.trim();

  return out;
}

async function readJson(filePath) {
  try {
    const text = await readFile(filePath, "utf8");
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export async function loadSettings({ cwd, globalPath, projectPath } = {}) {
  const globalFile = globalPath ?? path.join(os.homedir(), ".pi", "agent", "settings.json");
  const projectFile = projectPath ?? path.join(cwd ?? process.cwd(), ".pi", "settings.json");
  const [globalRaw, projectRaw] = await Promise.all([readJson(globalFile), readJson(projectFile)]);
  return {
    ...DEFAULT_SETTINGS,
    ...sanitizeSettings(globalRaw),
    ...sanitizeSettings(projectRaw),
  };
}
