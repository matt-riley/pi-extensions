#!/usr/bin/env node
/**
 * skill-search.mjs — the skill library as a command any agent can run.
 *
 * Wraps the same discovery and ranking that the `skill_select` pi tool uses,
 * so harnesses without a pi extension (Claude Code, Codex, Copilot, plain
 * scripts) can search the library and then read the matched SKILL.md.
 *
 * Usage:
 *   node scripts/skill-search.mjs "<plain-language task>" [options]
 *
 * Options:
 *   --limit N      Maximum matches to return (default 5, max 20).
 *   --json         Machine-readable output instead of the text view.
 *   --root DIR     Search only this root (repeatable). Defaults to the
 *                  standard roots: PI_SKILL_LIBRARY, ~/.pi/agent/skill-library,
 *                  ~/.pi/agent/skills, ~/.agents/skills, ~/.claude/skills,
 *                  ~/.codex/skills, and the project's .pi/skills /
 *                  .agents/skills.
 *   -h, --help     Show this help.
 *
 * Close calls are broken by TypeSafe when a key is reachable (set
 * PI_SKILL_SELECT_TIEBREAK=0 to keep selection entirely local); the lexical
 * order is kept whenever that decision fails or is declined.
 *
 * Exit codes: 0 when matches were found, 1 when none, 2 on bad usage.
 */

import { homedir } from "node:os";

import { DEFAULT_LIMIT, discoverSkills, formatMatches, rankSkills, resolveRoots } from "../packages/skill-select/library.mjs";
import { tiebreakMatches } from "../packages/skill-select/tiebreak.mjs";

function parseArgs(argv) {
  const args = { query: "", limit: DEFAULT_LIMIT, json: false, roots: [], help: false, error: null };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--help" || token === "-h") {
      args.help = true;
    } else if (token === "--json") {
      args.json = true;
    } else if (token === "--limit" || token.startsWith("--limit=")) {
      const raw = token === "--limit" ? argv[++index] : token.slice("--limit=".length);
      const limit = Number(raw);
      if (!Number.isInteger(limit) || limit < 1) {
        args.error = `--limit needs a positive integer, got "${raw ?? ""}"`;
      } else {
        args.limit = limit;
      }
    } else if (token === "--root" || token.startsWith("--root=")) {
      const raw = token === "--root" ? argv[++index] : token.slice("--root=".length);
      if (!raw) {
        args.error = "--root needs a directory";
      } else {
        args.roots.push(raw);
      }
    } else if (token.startsWith("-") && token !== "-") {
      args.error = `unknown option: ${token}`;
    } else {
      positional.push(token);
    }
  }
  args.query = positional.join(" ").trim();
  return args;
}

function renderHelp() {
  return [
    "Usage:",
    '  node scripts/skill-search.mjs "<plain-language task>" [options]',
    "",
    "Options:",
    `  --limit N      Maximum matches to return (default ${DEFAULT_LIMIT}, max 20).`,
    "  --json         Machine-readable output instead of the text view.",
    "  --root DIR     Search only this root (repeatable; replaces the defaults).",
    "  -h, --help     Show this help.",
    "",
    "Prints ranked skill matches and the path to each SKILL.md. Read the chosen",
    "file and follow it; the one-line description is a hint, not the skill.",
  ].join("\n");
}

const args = parseArgs(process.argv.slice(2));
if (args.error) {
  console.error(args.error);
  console.error(renderHelp());
  process.exit(2);
}
if (args.help) {
  console.log(renderHelp());
  process.exit(0);
}

const roots = args.roots.length > 0
  ? args.roots
  : resolveRoots({ cwd: process.cwd(), home: homedir(), env: process.env });
const skills = await discoverSkills({ roots });
const matches = rankSkills(skills, args.query, { limit: args.limit });
const adjusted = await tiebreakMatches({ query: args.query, matches, env: process.env });

if (args.json) {
  console.log(JSON.stringify({
    query: args.query,
    total: skills.length,
    matches: adjusted.matches.map(({ name, description, path, score, root }) => ({ name, description, path, score, root })),
    tiebreak: { applied: adjusted.applied, reason: adjusted.reason, chosen: adjusted.chosen ?? null },
  }, null, 2));
} else {
  const note = adjusted.applied
    ? `TypeSafe promoted "${adjusted.chosen}" because the lexical scores were close.`
    : null;
  console.log(formatMatches(adjusted.matches, { query: args.query, total: skills.length, note }));
}

process.exitCode = matches.length > 0 ? 0 : 1;
