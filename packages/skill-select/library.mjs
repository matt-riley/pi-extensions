// library.mjs — skill library discovery and ranking for the skill_select tool.
//
// Plain .mjs so node --test can cover it without a TS loader (see AGENTS.md).
// The extension entrypoint only registers the tool; discovery, frontmatter
// parsing, ranking and formatting live here so they stay testable with no
// network and no model.

import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

export const DEFAULT_LIMIT = 5;
export const MAX_LIMIT = 20;

const SKILL_FILE = /^skill\.md$/i;
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const MAX_DEPTH = 6;
const MAX_SKILLS = 500;
const DESCRIPTION_CHARS = 200;

// Small stopword set: query words that carry no selection signal.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "for", "to", "of", "in", "on", "with", "my",
  "me", "i", "is", "it", "this", "that", "how", "do", "does", "use", "using",
  "when", "what", "which", "can", "should", "need", "want", "please", "help",
]);

function tokenize(text) {
  return String(text ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length >= 2 && !STOPWORDS.has(token));
}

function normalizePhrase(text) {
  return String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function unquote(value) {
  const text = String(value ?? "").trim();
  if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

/**
 * Parse the `name` and `description` keys out of a SKILL.md frontmatter block.
 * Deliberately a small YAML subset — plain, quoted, folded (>) and literal (|)
 * scalars — because the library has zero dependencies.
 */
export function parseFrontmatter(text) {
  const result = { name: "", description: "" };
  const normalized = String(text ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return result;
  }
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) {
    return result;
  }
  const lines = normalized.slice(4, end).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(name|description):\s*(.*)$/.exec(lines[index]);
    if (!match) {
      continue;
    }
    const [, key, rawValue] = match;
    const value = rawValue.trim();
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const collected = [];
      while (index + 1 < lines.length && (lines[index + 1].trim() === "" || /^\s+\S/.test(lines[index + 1]))) {
        collected.push(lines[index + 1].trim());
        index += 1;
      }
      result[key] = value.startsWith("|")
        ? collected.join("\n").trim()
        : collected.filter(Boolean).join(" ").trim();
      continue;
    }
    result[key] = unquote(value);
  }
  return result;
}

/**
 * Candidate skill directories, highest priority first. PI_SKILL_LIBRARY is the
 * escape hatch: skills kept there are never listed by pi's skill discovery, so
 * they cost no context until skill_select finds them.
 */
export function resolveRoots({ cwd = process.cwd(), home = process.env.HOME ?? "", env = process.env } = {}) {
  const configured = String(env?.PI_SKILL_LIBRARY ?? "")
    .split(/[,:]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
  const candidates = [
    ...configured,
    home ? join(home, ".pi", "agent", "skill-library") : "",
    home ? join(home, ".pi", "agent", "skills") : "",
    home ? join(home, ".agents", "skills") : "",
    home ? join(home, ".claude", "skills") : "",
    home ? join(home, ".codex", "skills") : "",
    cwd ? join(cwd, ".pi", "skills") : "",
    cwd ? join(cwd, ".agents", "skills") : "",
  ].filter(Boolean);
  return [...new Set(candidates)];
}

async function walkSkillFiles(dir, onFile, depth = 0) {
  if (depth > MAX_DEPTH) {
    return;
  }
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // Missing or unreadable roots are simply empty.
  }
  for (const entry of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) {
        continue;
      }
      await walkSkillFiles(join(dir, entry.name), onFile, depth + 1);
      continue;
    }
    if (entry.isFile() && SKILL_FILE.test(entry.name)) {
      await onFile(join(dir, entry.name));
    }
  }
}

/**
 * Discover skills under `roots`. Earlier roots win when two skills share a
 * name, so a library copy overrides an auto-discovered one.
 *
 * @returns {Promise<Array<{ name: string, description: string, path: string, root: string }>>}
 */
export async function discoverSkills({ roots = [], limit = MAX_SKILLS } = {}) {
  const skills = [];
  const seen = new Set();
  for (const root of roots) {
    await walkSkillFiles(root, async (filePath) => {
      if (skills.length >= limit) {
        return;
      }
      let text = "";
      try {
        text = await readFile(filePath, "utf8");
      } catch {
        return;
      }
      const frontmatter = parseFrontmatter(text);
      const name = frontmatter.name || basename(join(filePath, ".."));
      if (!name || seen.has(name)) {
        return;
      }
      seen.add(name);
      skills.push({
        name,
        description: frontmatter.description || "",
        path: filePath,
        root,
      });
    });
  }
  return skills;
}

/**
 * Rank skills against a plain-language query. Deterministic and dependency
 * free: name matches outrank description matches, and a query-wide phrase
 * match outranks individual tokens. An empty query browses the catalog.
 */
export function rankSkills(skills, query, { limit = DEFAULT_LIMIT } = {}) {
  const boundedLimit = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, MAX_LIMIT));
  const queryText = String(query ?? "").trim();
  if (!queryText) {
    return [...skills]
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(0, boundedLimit)
      .map((entry) => ({ ...entry, score: 0 }));
  }

  const queryNorm = normalizePhrase(queryText);
  const tokens = tokenize(queryText);
  const scored = skills.map((entry) => {
    const nameNorm = normalizePhrase(entry.name);
    const descriptionText = String(entry.description ?? "").toLowerCase();
    let score = 0;
    if (nameNorm === queryNorm) {
      score += 10;
    }
    if (queryNorm.length >= 4 && nameNorm.includes(queryNorm)) {
      score += 6;
    } else if (queryNorm.length >= 4 && descriptionText.includes(queryNorm)) {
      score += 3;
    }
    const nameTokens = new Set(tokenize(entry.name));
    const descriptionTokens = new Set(tokenize(descriptionText));
    for (const token of tokens) {
      if (nameTokens.has(token)) {
        score += 3;
      } else if (nameNorm.includes(token)) {
        score += 2;
      }
      if (descriptionTokens.has(token)) {
        score += 1.5;
      }
    }
    return { ...entry, score };
  });

  return scored
    .filter((entry) => entry.score > 0)
    .sort((left, right) => (right.score - left.score) || left.name.localeCompare(right.name))
    .slice(0, boundedLimit);
}

function truncate(text, max = DESCRIPTION_CHARS) {
  const value = String(text ?? "").replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Render matches as compact text with the path the model should read next. */
export function formatMatches(matches, { query = "", total = 0 } = {}) {
  if (matches.length === 0) {
    const quoted = String(query ?? "").trim();
    return quoted
      ? `No skill matched "${quoted}" (${total} skills searched). Try a plain-language description of the task.`
      : `No skills found (${total} skills searched).`;
  }
  const header = query
    ? `Skills matching "${String(query).trim()}" (${matches.length} of ${total}):`
    : `Skills (${matches.length} of ${total}):`;
  const lines = [header];
  matches.forEach((match, index) => {
    const score = match.score > 0 ? ` (score ${match.score})` : "";
    lines.push(`${index + 1}. ${match.name}${score} — ${truncate(match.description)}`);
    lines.push(`   ${match.path}`);
  });
  lines.push("");
  lines.push("Read the chosen SKILL.md with the read tool, then follow its instructions.");
  return lines.join("\n");
}
