// Initialization instructions shared by the command and its tests. The active
// agent inspects the repository and edits the file using its normal tools.
export const AGENTS_FILE = "AGENTS.md";

export function agentsPrompt({ dir, path, target }) {
  return [
    `Create or improve the agent instructions at ${JSON.stringify(path)} for the directory ${JSON.stringify(dir)} and below.`,
    `Only edit ${JSON.stringify(target)}. If the instructions path is a symlink, keep the symlink and edit its resolved target instead. Do not change other context files, project code, or global configuration.`,
    "Read the complete existing file before editing, if present. Preserve useful existing guidance, project-specific rules, commands, caveats, and user edits; improve or correct it only when repository evidence supports the change. A Commands heading is not a reason to stop. Leave it unchanged if there is nothing useful to improve.",
    "Inspect this directory and relevant repository context: README and contributor docs, manifests and lockfiles, build/test configuration, CI, and representative source and tests. Read applicable ancestor instructions and nearby nested AGENTS.md files; respect their scope and avoid duplicating inherited guidance. Do not scan dependencies, generated output, secrets, or version-control internals.",
    "Use https://agents.md/#examples as the primary guide to what belongs here: actionable development environment tips, testing instructions, and commit/pull request guidance. Also include a concise project overview, important structure, code style, or security gotchas where supported by this project. The examples guide content, not commands to copy verbatim; no network fetch is required to use these categories.",
    "Document the actual package manager and working directory for setup, build, test, lint, and type-check commands that are relevant. Support non-JavaScript projects too. Prefer a few useful commands and pitfalls over listing every script or lifecycle hook. Do not invent commands, policies, architecture, or test results. Omit unsupported sections and generic filler; do not add placeholders or a copy of the README.",
    "Re-read the target before editing so queued work does not overwrite intervening changes. If an AGENTS.override.md now shadows AGENTS.md, report it instead of editing a shadowed file. Create AGENTS.md if absent. If the selected directory disappears, an existing instructions file cannot be read, or a write fails, report the problem without replacing existing guidance. Review the final diff for lost guidance and unrelated edits. Briefly report what changed and any uncertainty; do not claim checks passed unless you ran them.",
  ].join("\n\n");
}
