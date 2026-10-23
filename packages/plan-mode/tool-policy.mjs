// Which tools plan mode may run. Annotations decide for tools that declare
// them. Tools from other packages that declare none keep today's allowlist.

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
  if (tool === "bash") return "bash";
  if (tool === "plan_mode_complete") return "allow";
  const exposure = info?.exposure;
  if (exposure === "deferred" && !PLAN_OWNED.has(tool)) return "block";
  const annotations = info?.annotations;
  if (annotations && typeof annotations.readOnlyHint === "boolean") {
    if (annotations.readOnlyHint !== true) return "block";
    const open = annotations.openWorldHint === true;
    if (open && !PLAN_OWNED.has(tool) && !PLAN_OPEN_WORLD.has(tool)) return "block";
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
