// MCP-shaped hints stored on Pi 1.4.0 ToolDefinition.annotations.
//
// readOnlyHint — the tool does not modify its environment.
// destructiveHint — the tool may delete or overwrite data. Meaningful when not
// read-only; false on readers so the two hints cannot contradict.
// openWorldHint — the tool reaches external entities (the web, TypeSafe), not
// a closed local domain.
//
// A derived cache under .pi/cache is not a user-data mutation: the code-search
// tools stay read-only. The cache is rebuilt from the repo and a failed write
// is ignored.
//
// Pi copies an MCP server's own hints onto its tools and does not verify them.
// sourceInfo records which extension file registered a tool, and that path is
// wherever this clone is installed, so it cannot name the repo. The set below
// is the list of tools this repo registers. readOnlyHint: true is trusted only
// for those names. readOnlyHint: false is stricter and is honoured for any tool.

export const OWNED_TOOL_NAMES = new Set([
  "repo_map",
  "code_search",
  "file_outline",
  "find_definition",
  "skill_select",
  "view_context",
  "web_fetch",
  "web_search",
  "typesafe_ask",
  "read_relevant",
  "self_compact",
  "subagent",
  "web_answer",
  "batch_web_fetch",
  "lint_change",
  "verify_findings",
  "blast_radius",
  "watch_pr",
  "find_code",
  "diagnosis_checkpoint",
  "measure_command",
  "terminal_start",
  "terminal_read",
  "terminal_list",
  "terminal_send",
  "terminal_stop",
  "plan_mode_question",
  "plan_fetch_url",
  "plan_mode_complete",
  "influencer_save",
  "influencer_show",
  "influencer_list",
  "influencer_prompt",
]);

/**
 * How far a declared readOnlyHint can be trusted.
 * `true` only for a tool this repo registers. `false` from any caller, because
 * that is the stricter claim. `null` means the hint is missing or is an
 * outside read-only claim, and the caller keeps its name rule.
 * @param {string} name
 * @param {{ readOnlyHint?: boolean } | null | undefined} annotations
 * @returns {boolean | null}
 */
export function trustedReadOnlyHint(name, annotations) {
  if (!annotations || typeof annotations !== "object") return null;
  if (annotations.readOnlyHint === false) return false;
  if (annotations.readOnlyHint === true && OWNED_TOOL_NAMES.has(String(name ?? "").toLowerCase()))
    return true;
  return null;
}

export const LOCAL_READ = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
});

export const OPEN_READ = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: true,
});

export const LOCAL_DESTRUCTIVE = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: false,
});

export const OPEN_DESTRUCTIVE = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  openWorldHint: true,
});
