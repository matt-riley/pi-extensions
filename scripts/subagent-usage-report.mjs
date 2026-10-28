#!/usr/bin/env node
// subagent-usage-report.mjs — which subagent types are earning their keep.
//
// Reads pi session JSONL (default ~/.pi/agent/sessions, or --sessions) and the
// jev-decision entries the subagents extension appends. Prints counts only.
// Read-only: it never writes into the sessions directory.
//
//   node scripts/subagent-usage-report.mjs [--json] [--since <date>] [--limit <n>] [--sessions <dir>]

import path from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

import { builtinAgentTypes, buildReport, formatReport } from "./subagent-usage-report-lib.mjs";

const DEFAULT_SESSIONS = path.join(homedir(), ".pi", "agent", "sessions");

function parseSince(value) {
  if (!value || value.startsWith("--")) return null;
  const stamp = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value;
  const parsed = Date.parse(stamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseArgs(argv) {
  const opts = {
    json: false,
    since: null,
    limit: null,
    sessions: DEFAULT_SESSIONS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") opts.json = true;
    else if (arg === "--since") {
      const value = argv[(index += 1)];
      const parsed = parseSince(value);
      if (parsed === null) throw new Error("--since needs a date (YYYY-MM-DD)");
      opts.since = parsed;
    } else if (arg === "--limit") {
      const value = Number(argv[(index += 1)]);
      if (!Number.isInteger(value) || value < 1)
        throw new Error("--limit needs a positive integer");
      opts.limit = value;
    } else if (arg === "--sessions") {
      const value = argv[(index += 1)];
      if (!value || value.startsWith("--")) throw new Error("--sessions needs a directory");
      opts.sessions = value;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return opts;
}

function run(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  const report = buildReport({
    dir: opts.sessions,
    since: opts.since,
    limit: opts.limit,
    builtins: builtinAgentTypes(),
  });
  console.log(opts.json ? JSON.stringify(report, null, 2) : formatReport(report));
  return report;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "report failed");
    process.exit(1);
  }
}
