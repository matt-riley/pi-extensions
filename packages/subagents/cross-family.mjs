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
export function pickCrossFamily(parentModel, available, patterns) {
  const parentFamily = modelFamily(modelKey(parentModel));
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
export async function resolveCrossFamily(modelRegistry, parentModel, routerFile) {
  let available = [];
  try {
    const listed = await Promise.resolve(modelRegistry?.getAvailable?.());
    available = Array.isArray(listed) ? listed : [];
  } catch {
    available = [];
  }
  return pickCrossFamily(parentModel, available, readPatterns(routerFile));
}
