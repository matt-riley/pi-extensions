import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const INPUT_KEYS = new Set(["age", "gender", "ethnicity", "niche", "quirk"]);
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
let tempCounter = 0;

export function characterDirectory(home) {
  return path.join(home, ".pi", "agent", "influencers");
}

function isValidSlug(slug) {
  return typeof slug === "string" && SLUG_PATTERN.test(slug);
}

export function slugify(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function cleanString(value) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function normalizeInputs(value) {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("inputs must be an object");
  }

  const result = {};
  for (const [key, input] of Object.entries(value)) {
    if (!INPUT_KEYS.has(key) && key !== "brief") continue;
    const cleaned = cleanString(input);
    if (cleaned) result[key] = cleaned;
  }
  return result;
}

function normalizeList(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be an array of strings`);

  return value.map((item, index) => {
    const cleaned = cleanString(item);
    if (!cleaned) throw new Error(`${field}[${index}] must not be empty`);
    return cleaned;
  });
}

function mergeList(existing, incoming, field) {
  if (incoming === undefined) return normalizeList(existing, field);
  const values = normalizeList(incoming, field);
  // A save without anchors must not erase an already locked identity.
  return values.length > 0 || normalizeList(existing, field).length === 0
    ? values
    : normalizeList(existing, field);
}

export function mergeCharacter(existing, patch = {}, now = new Date().toISOString()) {
  const source = existing ?? {};
  const slug = slugify(patch.slug ?? source.slug ?? patch.name ?? source.name);
  if (!isValidSlug(slug)) throw new Error("A character needs a non-empty slug");

  const inputs = {
    ...normalizeInputs(source.inputs),
    ...normalizeInputs(patch.inputs),
  };
  const anchors = mergeList(source.anchors, patch.anchors, "anchors");
  const silhouette = mergeList(source.silhouette, patch.silhouette, "silhouette");
  const lockedAt = source.lockedAt ?? (anchors.length > 0 ? now : null);

  return {
    slug,
    name: cleanString(patch.name ?? source.name) || slug,
    inputs,
    prompt: cleanString(patch.prompt ?? source.prompt),
    anchors,
    silhouette,
    styleSignature: cleanString(patch.styleSignature ?? source.styleSignature),
    lockedAt,
    createdAt: source.createdAt ?? now,
    updatedAt: now,
  };
}

function prepareRecord(record) {
  const now = new Date().toISOString();
  const slug = slugify(record?.slug ?? record?.name);
  if (!isValidSlug(slug)) throw new Error("A character needs a non-empty slug");

  const anchors = normalizeList(record.anchors, "anchors");
  return {
    slug,
    name: cleanString(record.name) || slug,
    inputs: normalizeInputs(record.inputs),
    prompt: cleanString(record.prompt),
    anchors,
    silhouette: normalizeList(record.silhouette, "silhouette"),
    styleSignature: cleanString(record.styleSignature),
    lockedAt: record.lockedAt ?? (anchors.length > 0 ? now : null),
    createdAt: record.createdAt ?? now,
    updatedAt: record.updatedAt ?? now,
  };
}

function characterPath(directory, slug) {
  if (!isValidSlug(slug)) throw new Error(`Invalid character slug: ${slug}`);
  return path.join(directory, `${slug}.json`);
}

export async function readCharacter(directory, slug) {
  const filename = characterPath(directory, slug);
  let content;
  try {
    content = await readFile(filename, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }

  const record = JSON.parse(content);
  if (!record || typeof record !== "object" || record.slug !== slug) {
    throw new Error(`Invalid character record: ${filename}`);
  }
  return record;
}

export async function writeCharacter(directory, record) {
  const normalized = prepareRecord(record);
  const filename = characterPath(directory, normalized.slug);
  const temporary = `${filename}.${process.pid}.${Date.now()}.${tempCounter++}.tmp`;
  await mkdir(directory, { recursive: true });

  try {
    await writeFile(temporary, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    await rename(temporary, filename);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return filename;
}

export async function listCharacters(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const slug = entry.name.slice(0, -5);
    try {
      const record = await readCharacter(directory, slug);
      if (record) records.push(record);
    } catch {
      // One malformed record must not hide the rest of the roster.
    }
  }

  return records.sort((left, right) =>
    String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")),
  );
}
