// discover.mjs — load agent .md files. Highest wins: project > user > builtin.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { clampMaxTurns, clampTimeoutMs } from "./result.mjs";

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
export const WRITE_TOOLS = new Set(["edit", "write"]);

// Read-only fallback when an agent omits tools:. Explicit allowlist of known-safe
// tools — never a blocklist, so a future mutating extension tool cannot leak in.
export const READ_ONLY_DEFAULT_TOOLS = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
  "repo_map",
  "code_search",
  "file_outline",
  "find_definition",
  "web_search",
  "web_fetch",
  "batch_web_fetch",
];

export function parseToolList(value) {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const tools = raw
    .filter((item) => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
  return tools.length > 0 ? tools : undefined;
}

export function parseSimpleFrontmatter(content) {
  const text = String(content ?? "");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { frontmatter: {}, body: text };
  return { frontmatter: parseSimpleYaml(match[1]), body: match[2] };
}

function parseSimpleYaml(block) {
  const out = {};
  for (const line of String(block).split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const match = line.match(/^([A-Za-z0-9_]+):\s*(.*?)\s*$/);
    if (!match) continue;
    out[match[1]] = coerceYamlScalar(match[2]);
  }
  return out;
}

function coerceYamlScalar(raw) {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw === "" || raw === "null" || raw === "~") return null;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (
    (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) ||
    (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2)
  ) {
    return raw.slice(1, -1);
  }
  if (raw.startsWith("[") && raw.endsWith("]")) {
    return raw
      .slice(1, -1)
      .split(",")
      .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
  }
  return raw;
}

function slugName(filePath) {
  return path.basename(filePath, path.extname(filePath));
}

export function parseAgentContent(content, filePath, parseFrontmatter) {
  let frontmatter = {};
  let body = "";
  try {
    const parsed = parseFrontmatter ? parseFrontmatter(content) : parseSimpleFrontmatter(content);
    frontmatter = parsed?.frontmatter && typeof parsed.frontmatter === "object" ? parsed.frontmatter : {};
    body = typeof parsed?.body === "string" ? parsed.body : "";
  } catch {
    return null;
  }

  const slug = slugName(filePath);
  const name = typeof frontmatter.name === "string" && frontmatter.name.trim() ? frontmatter.name.trim() : slug;
  const description =
    typeof frontmatter.description === "string" && frontmatter.description.trim()
      ? frontmatter.description.trim()
      : slug;
  const toolsListed = frontmatter.tools !== undefined && frontmatter.tools !== null && frontmatter.tools !== "";
  const tools = parseToolList(frontmatter.tools);
  const model = typeof frontmatter.model === "string" && frontmatter.model.trim() ? frontmatter.model.trim() : undefined;
  const thinkingRaw = typeof frontmatter.thinking === "string" ? frontmatter.thinking.trim() : "";
  const thinking = THINKING_LEVELS.includes(thinkingRaw) ? thinkingRaw : undefined;
  const maxTurns = clampMaxTurns(frontmatter.max_turns);
  const timeoutMs = clampTimeoutMs(frontmatter.timeout_ms);
  const enabled = frontmatter.enabled !== false && frontmatter.enabled !== "false";

  return {
    name,
    description,
    tools,
    toolsListed,
    model,
    thinking,
    maxTurns,
    timeoutMs,
    enabled,
    systemPrompt: body.trim(),
    filePath,
  };
}

export function loadAgentsFromDir(dir, source, parseFrontmatter, warn) {
  const agents = [];
  if (!dir || !existsSync(dir)) return agents;

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    warn?.(`Could not read agents in ${dir}: ${error.message}`);
    return agents;
  }

  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const filePath = path.join(dir, entry.name);
    let content;
    try {
      content = readFileSync(filePath, "utf8");
    } catch (error) {
      warn?.(`Skipped unreadable agent ${filePath}: ${error.message}`);
      continue;
    }
    const parsed = parseAgentContent(content, filePath, parseFrontmatter);
    if (!parsed) {
      warn?.(`Skipped unparseable agent ${filePath}`);
      continue;
    }
    agents.push({ ...parsed, source });
  }
  return agents;
}

export function discoverAgents({
  builtinDir,
  userDir,
  projectDir,
  projectTrusted = false,
  parseFrontmatter,
  warn,
} = {}) {
  const byName = new Map();
  const apply = (list) => {
    for (const agent of list) {
      const key = agent.name.toLowerCase();
      if (!agent.enabled) {
        byName.delete(key);
        continue;
      }
      byName.set(key, agent);
    }
  };

  apply(loadAgentsFromDir(builtinDir, "builtin", parseFrontmatter, warn));
  apply(loadAgentsFromDir(userDir, "user", parseFrontmatter, warn));
  if (projectTrusted) {
    apply(loadAgentsFromDir(projectDir, "project", parseFrontmatter, warn));
  }
  return { agents: [...byName.values()] };
}

export function findAgent(agents, name) {
  const key = String(name ?? "").trim().toLowerCase();
  if (!key) return undefined;
  return agents.find((agent) => agent.name.toLowerCase() === key);
}

// True when the child's bash must be restricted to the read-only allowlist.
// Full bash only when the agent explicitly declares edit/write — for builtins
// and custom agents alike. "No write tools" must not mean "can rm -rf".
export function usesAllowlistedBash(agent) {
  if (!agent) return true;
  return !isWriteCapable(agent);
}

export function isWriteCapable(agent) {
  if (!agent?.toolsListed || !agent.tools) return false;
  return agent.tools.some((tool) => WRITE_TOOLS.has(tool));
}

// The child's tool selection. A declared tools: list is honored for every agent
// (builtin or custom); without one the child gets the explicit read-only set.
export function resolveChildTools(agent) {
  if (agent?.toolsListed && agent?.tools?.length) {
    return { tools: [...agent.tools], excludeTools: ["subagent"] };
  }
  return { tools: [...READ_ONLY_DEFAULT_TOOLS], excludeTools: ["subagent"] };
}
