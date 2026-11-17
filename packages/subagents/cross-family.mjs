// cross-family.mjs — pick a reviewer model from a different family than the parent.
//
// A reviewer on the same model family as the author tends to share its blind
// spots. Agents whose frontmatter says `model: cross-family` get the strongest
// model in ~/.pi/agent/router.json that is authenticated and belongs to another
// family. With nothing eligible, or a parent whose family is unknown (the
// router's virtual model), the child inherits the parent and carries a note.

import fs from "node:fs";

export const CROSS_FAMILY = "cross-family";

const FAMILIES = [
  [/^(gpt|o\d|chatgpt|codex)/, "openai"],
  [/^claude/, "anthropic"],
  [/^grok/, "xai"],
  [/^qwen/, "qwen"],
  [/^kimi/, "moonshot"],
  [/^deepseek/, "deepseek"],
  [/^(gemini|gemma)/, "google"],
  [/^glm/, "zhipu"],
  [/^(mistral|codestral|devstral|magistral)/, "mistral"],
  [/^llama/, "meta"],
];

function modelKey(model) {
  const value = model?.model ?? model;
  if (!value) return null;
  if (typeof value === "string") return value;
  const provider = value.provider ?? value.providerId ?? "";
  const id = value.id ?? value.modelId ?? value.name ?? "";
  if (!provider && !id) return null;
  return provider ? `${provider}/${id}` : String(id);
}

/** Family by model id, so openai/gpt-x and openai-codex/gpt-x are one family. */
export function modelFamily(key) {
  const value = String(key ?? "").toLowerCase();
  if (!value || value === "router/auto") return null;
  const id = value.slice(value.lastIndexOf("/") + 1);
  for (const [pattern, family] of FAMILIES) if (pattern.test(id)) return family;
  return null;
}

/** router.json patterns, strongest tier first, de-duplicated. */
export function readPatterns(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const out = [];
  for (const tier of ["frontier", "mid", "base"]) {
    const list = Array.isArray(parsed?.[tier]) ? parsed[tier] : [];
    for (const entry of list) {
      const model = String(typeof entry === "string" ? entry : (entry?.model ?? "")).trim();
      if (model && !out.includes(model)) out.push(model);
    }
  }
  return out;
}

/**
 * Choose the first pattern (in preference order) that matches an available
 * model of a different family from the parent. Pure: callers supply the list.
 */
export function pickCrossFamily(parentModel, available, patterns, options = {}) {
  const physicalParentKey =
    typeof options.physicalParentKey === "string" ? options.physicalParentKey.trim() : "";
  const parentFamily = modelFamily(physicalParentKey || modelKey(parentModel));
  if (!parentFamily) {
    return { model: parentModel, note: "cross-family: parent family unknown; inherited parent" };
  }
  const offers = (Array.isArray(available) ? available : [])
    .map((model) => ({ model, key: String(modelKey(model) ?? "").toLowerCase() }))
    .filter((entry) => entry.key);
  for (const pattern of patterns ?? []) {
    const wanted = String(pattern).toLowerCase();
    const match = offers.find((entry) => {
      const family = modelFamily(entry.key);
      return family && family !== parentFamily && entry.key.includes(wanted);
    });
    if (match) return { model: match.model, note: `cross-family: ${modelKey(match.model)}` };
  }
  return {
    model: parentModel,
    note: `cross-family: no authenticated model outside ${parentFamily} in router.json; inherited parent`,
  };
}

/** Registry-facing wrapper: getAvailable() lists only authenticated models. */
export async function resolveCrossFamily(modelRegistry, parentModel, routerFile, options = {}) {
  let available = [];
  try {
    const listed = await Promise.resolve(modelRegistry?.getAvailable?.());
    available = Array.isArray(listed) ? listed : [];
  } catch {
    available = [];
  }
  return pickCrossFamily(parentModel, available, readPatterns(routerFile), options);
}

// Panels: several vendors attempting or attacking the same thing.

/** `roles.panel` and `roles.judge` from router.json; a missing or malformed key is empty. */
export function readRoles(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return { panel: [], judge: [] };
  }
  const list = (value) =>
    (Array.isArray(value) ? value : []).map((entry) => String(entry ?? "").trim()).filter(Boolean);
  return { panel: list(parsed?.roles?.panel), judge: list(parsed?.roles?.judge) };
}

function offersOf(available) {
  return (Array.isArray(available) ? available : [])
    .map((model) => String(modelKey(model) ?? ""))
    .filter(Boolean);
}

/** First available key matching a router.json pattern (a substring, as in pickCrossFamily). */
function matchPattern(offers, pattern) {
  const wanted = String(pattern).toLowerCase();
  return offers.find((key) => key.toLowerCase().includes(wanted));
}

/**
 * Up to `size` authenticated models, one per vendor: claude-fable and
 * claude-opus share a seat, because modelFamily reads the vendor from the id
 * and one vendor's models share its blind spots. `preferred` (roles.panel) is
 * honoured in order first, then the tiers, strongest first.
 * Returns { seats: "provider/id"[], notes }.
 */
export function pickPanel(available, patterns, { size = 3, preferred = [] } = {}) {
  const offers = offersOf(available);
  const seats = [];
  const families = new Set();
  const notes = [];
  const take = (pattern, fromRoles) => {
    if (seats.length >= size) return;
    const key = matchPattern(offers, pattern);
    const family = key ? modelFamily(key) : null;
    if (key && family && !families.has(family)) {
      families.add(family);
      seats.push(key);
    } else if (fromRoles) {
      let note;
      if (!key) note = `roles.panel: ${pattern} is not authenticated; skipped`;
      else if (family)
        note = `roles.panel: ${key} skipped, ${family} already has a seat (one seat per vendor)`;
      else note = `roles.panel: ${key} skipped, its vendor is unknown`;
      notes.push(note);
    }
  };
  for (const pattern of preferred) take(pattern, true);
  for (const pattern of patterns ?? []) take(pattern, false);
  return { seats, notes };
}

/** First entry of `pool` that is authenticated and outside the parent's vendor. */
export function pickJudge(parentModel, available, pool, options = {}) {
  const parent = familyOfParent(parentModel, options);
  if (!parent) return undefined;
  const offers = offersOf(available);
  for (const pattern of pool ?? []) {
    const key = matchPattern(offers, pattern);
    const family = key ? modelFamily(key) : null;
    if (family && family !== parent) return key;
  }
  return undefined;
}

function familyOfParent(parentModel, options) {
  const physical =
    typeof options?.physicalParentKey === "string" ? options.physicalParentKey.trim() : "";
  return modelFamily(physical || modelKey(parentModel));
}

/** Registry-facing wrapper for the review_panel tool: { seats, judge?, notes }. */
export async function resolvePanel(modelRegistry, parentModel, routerFile, options = {}) {
  let available = [];
  try {
    const listed = await Promise.resolve(modelRegistry?.getAvailable?.());
    available = Array.isArray(listed) ? listed : [];
  } catch {
    available = [];
  }
  const roles = readRoles(routerFile);
  const patterns = readPatterns(routerFile);
  const { seats, notes } = pickPanel(available, patterns, { preferred: roles.panel });
  const judgePool = roles.judge.length ? roles.judge : [...roles.panel, ...patterns];
  const judge = pickJudge(parentModel, available, judgePool, options);
  if (seats.length < 2)
    notes.push(
      `panel has ${seats.length} vendor${seats.length === 1 ? "" : "s"}: that repeats one set of blind spots. Authenticate models from other vendors and list them in router.json.`,
    );
  if (!judge)
    notes.push(
      familyOfParent(parentModel, options)
        ? "no authenticated judge outside the parent's vendor: judge yourself and say so."
        : "parent vendor unknown, so no judge can be shown to differ from it: judge yourself and say so.",
    );
  return judge ? { seats, judge, notes } : { seats, notes };
}
