#!/usr/bin/env node
// mine-transcripts.mjs — pull every user-authored message out of pi's session
// transcripts so a past conversation can be mined for repeated corrections.
//
//   node scripts/mine-transcripts.mjs                       # last 30 days, newest 300
//   node scripts/mine-transcripts.mjs --since 90 --limit 600
//   node scripts/mine-transcripts.mjs --project workv3 --json
//   node scripts/mine-transcripts.mjs --all
//
// This is the deterministic half of /mine: extraction. Which sessions matter and
// which messages are corrections is judgment, so it stays with the agent.
// Read-only — it never writes to the sessions directory.

import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

const SESSIONS_DIR = path.join(homedir(), ".pi", "agent", "sessions");
const MAX_TEXT = 400;

function positive(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function parseArgs(argv) {
  const opts = {
    dir: SESSIONS_DIR,
    sinceDays: 30,
    sinceExplicit: false,
    limit: 300,
    project: null,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--all") {
      opts.sinceDays = Infinity;
      opts.sinceExplicit = true;
    } else if (arg === "--since") {
      opts.sinceDays = positive(argv[++i], opts.sinceDays);
      opts.sinceExplicit = true;
    } else if (arg === "--limit") opts.limit = positive(argv[++i], opts.limit);
    else if (arg === "--project") opts.project = argv[++i] ?? null;
    else if (arg === "--dir") opts.dir = argv[++i] ?? SESSIONS_DIR;
    else if (arg === "--json") opts.json = true;
    else if (arg.startsWith("-")) throw new Error(`Unknown flag: ${arg}`);
  }
  // A project filter ignores the default window: an idle project would otherwise
  // silently return nothing. Only an explicit --since narrows it.
  if (opts.project && !opts.sinceExplicit) opts.sinceDays = Infinity;
  return opts;
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

// Pure: one transcript's raw JSONL lines -> that transcript's user messages,
// oldest first. Malformed lines are skipped. cwd tracks the session header.
export function extractUserMessages(lines) {
  const out = [];
  let cwd = "";
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry?.type === "session") {
      cwd = typeof entry.cwd === "string" ? entry.cwd : cwd;
      continue;
    }
    const message = entry?.message;
    if (entry?.type !== "message" || message?.role !== "user") continue;
    const text = messageText(message.content).replace(/\s+/g, " ").trim();
    if (!text) continue;
    const raw = entry.timestamp ?? message.timestamp;
    const ts = typeof raw === "number" ? new Date(raw).toISOString() : (raw ?? "");
    out.push({ ts, cwd, text });
  }
  return out;
}

export function formatMessage(event) {
  const text = event.text.length > MAX_TEXT ? `${event.text.slice(0, MAX_TEXT)}…` : event.text;
  const iso =
    typeof event.ts === "number" ? new Date(event.ts).toISOString() : String(event.ts ?? "");
  const date = iso.length >= 10 ? iso.slice(0, 10) : "unknown";
  const project = event.cwd ? path.basename(event.cwd) : "?";
  return `${date} [${project}] ${text}`;
}

function sessionFiles(dir) {
  try {
    return fs
      .readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => path.join(entry.parentPath ?? entry.path ?? dir, entry.name));
  } catch {
    return [];
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const cutoff = Number.isFinite(opts.sinceDays) ? Date.now() - opts.sinceDays * 86_400_000 : null;

  const events = [];
  let sessions = 0;
  for (const file of sessionFiles(opts.dir).sort()) {
    if (cutoff !== null) {
      let stat;
      try {
        stat = fs.statSync(file);
      } catch {
        continue;
      }
      if (stat.mtimeMs < cutoff) continue;
    }
    let lines;
    try {
      lines = fs.readFileSync(file, "utf8").split("\n");
    } catch {
      continue;
    }
    const found = extractUserMessages(lines).filter(
      (event) => !opts.project || event.cwd.includes(opts.project),
    );
    if (found.length === 0) continue;
    sessions += 1;
    events.push(...found);
  }

  events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  const shown = events.slice(-opts.limit);

  if (opts.json) {
    console.log(JSON.stringify(shown, null, 2));
    return;
  }

  const window = opts.project
    ? `project ~ ${opts.project}`
    : cutoff === null
      ? "all sessions"
      : `since ${new Date(cutoff).toISOString().slice(0, 10)}`;
  console.log(`# ${events.length} user messages across ${sessions} sessions (${window})`);
  console.log(`# showing the newest ${shown.length}; widen with --limit, --since, or --all`);
  for (const event of shown) console.log(formatMessage(event));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main();
