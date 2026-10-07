import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_DIR = path.dirname(fileURLToPath(import.meta.url));
const RECIPE_DIR = path.join(PACKAGE_DIR, "prompt-recipes");
const GUIDANCE_DIR = path.join(PACKAGE_DIR, "resources", "ai-influencer-prompt-builder");
const SEEDANCE_GUIDANCE_DIR = path.join(PACKAGE_DIR, "resources", "seedance-2-5-prompting");
const cache = new Map();

const DEFAULT_SLOTS = Object.freeze({
  outfit:
    "the established outfit from the locked identity; if no outfit is established, a simple neutral everyday outfit kept identical across all photographs",
  setting: "a simple neutral studio or indoor-wall background",
  lighting: "soft, neutral, real-world lighting similar to window light or soft studio light",
  duration:
    "Use the requested duration; otherwise allow enough time for natural action and dialogue without padding.",
  aspect_ratio: "16:9 horizontal unless the user requests another aspect ratio.",
  references:
    "Name only attached references, assign each one a distinct role, and use the exact labels shown by the target interface.",
  location: "the location and environment requested by the user",
  action: "the main action requested by the user, performed naturally and in real time",
  dialogue: "No dialogue unless the user provides or requests it; do not invent spoken words.",
  audio:
    "Use supplied exact dialogue audio as the spoken track when available; otherwise use natural location ambience and no unrequested music.",
  camera: "A stable, natural camera framing suited to the scene and requested action.",
  ending: "End after the requested action and any dialogue finish; hold a natural final state.",
});

function parseScalar(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed
      .slice(1, -1)
      .split(",")
      .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
  }
  return trimmed.replace(/^['"]|['"]$/g, "");
}

export function parseFrontmatter(content) {
  const match = String(content).match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { metadata: {}, body: String(content) };

  const metadata = {};
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf(":");
    if (separator < 1) throw new Error(`Invalid frontmatter line: ${line}`);
    const key = trimmed.slice(0, separator).trim();
    metadata[key] = parseScalar(trimmed.slice(separator + 1));
  }
  return { metadata, body: match[2].trim() };
}

async function readCached(filename) {
  if (!cache.has(filename)) cache.set(filename, await readFile(filename, "utf8"));
  return cache.get(filename);
}

export async function loadGuidance({ seedance = false } = {}) {
  const root = seedance ? SEEDANCE_GUIDANCE_DIR : GUIDANCE_DIR;
  const referencePath = seedance
    ? path.join(root, "references", "fal-seedance-2-5.md")
    : path.join(root, "references", "influencer-visual-language.md");
  const [skill, reference] = await Promise.all([
    readCached(path.join(root, "SKILL.md")),
    readCached(referencePath),
  ]);
  return { skill, reference, kind: seedance ? "seedance-2-5" : "influencer" };
}

export async function listRecipes(directory = RECIPE_DIR) {
  const entries = await readdir(directory, { withFileTypes: true });
  const recipes = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const id = entry.name.slice(0, -3);
    const filename = path.join(directory, entry.name);
    const parsed = parseFrontmatter(await readCached(filename));
    recipes.push({
      id,
      title: String(parsed.metadata.title ?? id),
      alias: parsed.metadata.alias ? String(parsed.metadata.alias) : null,
      description: String(parsed.metadata.description ?? ""),
      mode: String(parsed.metadata.mode ?? "image"),
      guidance: String(parsed.metadata.guidance ?? "influencer"),
      slots: Array.isArray(parsed.metadata.slots) ? parsed.metadata.slots.map(String) : [],
      body: parsed.body,
    });
  }
  return recipes.sort((left, right) => left.id.localeCompare(right.id));
}

export async function loadRecipe(identifier, directory = RECIPE_DIR) {
  const value = String(identifier ?? "")
    .trim()
    .toLowerCase();
  if (!value || value.includes("/") || value.includes("\\") || value.includes("..")) {
    throw new Error("Recipe names must be simple names, not file paths");
  }

  const recipes = await listRecipes(directory);
  const recipe = recipes.find((item) => item.id === value || item.alias === value);
  if (!recipe) {
    const available = recipes.map((item) => item.id).join(", ") || "none";
    throw new Error(`Unknown recipe "${identifier}". Available recipes: ${available}`);
  }
  return recipe;
}

export function substituteSlots(template, slots = {}) {
  const missing = new Set();
  const rendered = String(template).replace(/\{\{([a-z][a-z0-9_-]*)\}\}/gi, (match, name) => {
    const value = slots[name];
    if (value === undefined || value === null || String(value).trim() === "") {
      missing.add(name);
      return match;
    }
    return String(value).trim();
  });

  if (missing.size > 0) {
    throw new Error(`Missing recipe slots: ${[...missing].join(", ")}`);
  }
  return rendered;
}

export function renderRecipe(recipe, suppliedSlots = {}) {
  const allowed = new Set(recipe.slots ?? []);
  const unknown = Object.keys(suppliedSlots).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new Error(`Unknown recipe slots: ${unknown.join(", ")}`);
  }
  return substituteSlots(recipe.body, { ...DEFAULT_SLOTS, ...suppliedSlots });
}
