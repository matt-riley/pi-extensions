import { trustedReadOnlyHint } from "../../shared/tool-annotations.mjs";

// Which tools plan mode may run. readOnlyHint: true is trusted only for tools
// this repo registers. readOnlyHint: false blocks any tool. Tools that declare
// neither keep today's allowlist. Only exposure "direct" is a candidate;
// deferred, model-only, codemode, and hidden stay out unless plan mode owns them.

const EXTERNAL_PLAN_TOOLS = new Set(["read", "grep", "find", "ls", "lore_recall"]);

// Plan mode's own tools. They stay available even when deferred, because the
// mode is what activates them. plan_mode_complete writes the plan file.
const PLAN_OWNED = new Set(["plan_mode_question", "plan_mode_complete", "plan_fetch_url"]);

// The one open-world reader that was already the sanctioned search path.
// Other open-world readers (web_fetch, typesafe_ask, read_relevant) stay out,
// so planning does not grow a second fetch path or a paid judgment call.
const PLAN_OPEN_WORLD = new Set(["web_search"]);

// Used only when the tool registry cannot be read. Matches the previous
// hard-coded plan toolset so a lookup failure does not widen or empty the mode.
const HISTORICAL_PLAN_TOOLS = [
  "read",
  "bash",
  "grep",
  "find",
  "ls",
  "repo_map",
  "code_search",
  "file_outline",
  "find_definition",
  "skill_select",
  "lore_recall",
  "plan_mode_question",
  "plan_mode_complete",
  "plan_fetch_url",
  "web_search",
];

const EXTERNAL_PREFIX = ["read", "bash", "grep", "find", "ls", "lore_recall"];

function knownExposure(info) {
  return typeof info?.exposure === "string" ? info.exposure : null;
}

/**
 * @param {string} name
 * @param {{ annotations?: { readOnlyHint?: boolean, openWorldHint?: boolean }, exposure?: string } | undefined} info
 * @param {{ registryUnavailable?: boolean }} [options]
 * @returns {"allow" | "bash" | "block"}
 */
export function planToolVerdict(name, info, options = {}) {
  const tool = String(name ?? "");
  if (options.registryUnavailable) {
    if (tool === "bash") return "bash";
    return HISTORICAL_PLAN_TOOLS.includes(tool) ? "allow" : "block";
  }
  // Plan mode activates its own tools, including the deferred writer.
  if (PLAN_OWNED.has(tool)) return "allow";
  const exposure = knownExposure(info);
  // A recorded exposure other than direct is not offered. A missing exposure
  // means the registry snapshot had no entry, and the name rule below applies.
  if (exposure !== null && exposure !== "direct") return "block";
  if (tool === "bash") return "bash";
  // false from anyone is stricter than the name allowlist. true is trusted
  // only for tools this repo registers.
  const readOnly = trustedReadOnlyHint(tool, info?.annotations);
  if (readOnly === false) return "block";
  if (readOnly === true) {
    const open = info?.annotations?.openWorldHint === true;
    if (open && !PLAN_OPEN_WORLD.has(tool)) return "block";
    return "allow";
  }
  if (EXTERNAL_PLAN_TOOLS.has(tool)) return "allow";
  return "block";
}

/**
 * Active tool names for plan mode, in a stable order. `registered` is
 * `getAllTools()`; a non-array means the registry could not be read.
 * @param {Array<{ name?: string, annotations?: object, exposure?: string }> | null | undefined} registered
 */
export function selectPlanTools(registered) {
  if (!Array.isArray(registered)) return [...HISTORICAL_PLAN_TOOLS];
  const byName = new Map(registered.filter((tool) => tool?.name).map((tool) => [tool.name, tool]));
  const names = [];
  const consider = (toolName, info) => {
    const verdict = planToolVerdict(toolName, info);
    if ((verdict === "allow" || verdict === "bash") && !names.includes(toolName)) {
      names.push(toolName);
    }
  };
  for (const toolName of EXTERNAL_PREFIX) consider(toolName, byName.get(toolName));
  for (const tool of registered) {
    if (tool?.name) consider(tool.name, tool);
  }
  return names;
}
