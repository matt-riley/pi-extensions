// scaffold.mjs — pure decisions for /agents: what an AGENTS.md says, and how to
// add what is missing without rewriting what is there.
//
// Plain .mjs so node --test covers it without a TS loader (see AGENTS.md).

export const AGENTS_FILE = "AGENTS.md";

const SCOPE = "Guidance for coding agents working in this directory and below.";
// A heading whose text starts with "command", at any level, means the file
// already documents commands: the author's section wins over a generated one.
const COMMANDS_HEADING = /^#{1,6}[ \t]+commands?\b/im;

/** package.json scripts as command bullets. Non-string values are not commands. */
function commandLines(scripts) {
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return [];
  return Object.entries(scripts)
    .filter(([name, command]) => name.trim() && typeof command === "string")
    .map(([name]) => `- \`npm run ${name}\``);
}

/**
 * Decide what to write. `existing` is the current file content, or null when
 * there is no file. Existing bytes are never dropped or reordered: an update
 * only appends a Commands section to a file that has none.
 *
 * @returns {{ action: "create" | "update" | "unchanged", content: string, commandCount: number }}
 */
export function planAgentsFile(existing, { scripts } = {}) {
  const commands = commandLines(scripts);
  const commandCount = commands.length;

  if (existing === null || existing.trim() === "") {
    const lines = ["# AGENTS.md", "", SCOPE];
    if (commandCount) lines.push("", "## Commands", "", ...commands);
    return { action: "create", content: `${lines.join("\n")}\n`, commandCount };
  }
  if (!commandCount || COMMANDS_HEADING.test(existing)) {
    return { action: "unchanged", content: existing, commandCount };
  }
  // Keep every existing byte and add exactly one blank line between the old
  // content and the new section.
  const separator = existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  return {
    action: "update",
    content: `${existing}${separator}## Commands\n\n${commands.join("\n")}\n`,
    commandCount,
  };
}
