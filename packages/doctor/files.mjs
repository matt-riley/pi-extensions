// files.mjs — the two config files the doctor reads: router.json and agent .md files.
//
// Read-only. It reuses the loaders the features themselves use, so "parses" means
// what it means to the router and to subagents.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { readRouterConfig } from "../router/config.mjs";
import { parseAgentContent } from "../subagents/discover.mjs";

/** `missing` (defaults apply), `ok`, or `invalid` with the router's own error. */
export function routerState(file) {
  if (!existsSync(file)) return { state: "missing", path: file };
  const { error } = readRouterConfig(file);
  return error ? { state: "invalid", path: file, error } : { state: "ok", path: file };
}

/**
 * Every `.md` in the given agent directories, each checked with the subagents
 * parser. A directory that does not exist has no agents; one that exists and
 * cannot be read throws, so the caller reports unknown rather than "none".
 */
export function agentFileChecks(dirs, { parseFrontmatter }) {
  const results = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.name.endsWith(".md") && (entry.isFile() || entry.isSymbolicLink()))
      .map((entry) => entry.name)
      .sort();
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        const parsed = parseAgentContent(readFileSync(file, "utf8"), file, parseFrontmatter);
        results.push(
          parsed ? { path: file, ok: true } : { path: file, ok: false, error: "does not parse" },
        );
      } catch (error) {
        results.push({ path: file, ok: false, error: String(error?.message ?? error) });
      }
    }
  }
  return results;
}
