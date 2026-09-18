// replay-corpus.mjs — run the guardrail policy over real session history.
//
// The regression harness for packages/guardrail: it answers "how often would
// this have interrupted me?" with a number instead of an opinion. Sessions are
// pi's own JSONL transcripts under ~/.pi/agent/sessions.
//
//   node scripts/replay-corpus.mjs                 # summary
//   node scripts/replay-corpus.mjs --samples 5     # plus examples per verdict
//   node scripts/replay-corpus.mjs --list judge    # every judged command
//
// Read-only: it never executes what it reads.

import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

import { evaluateToolCall, evaluateBashCommand } from "../packages/guardrail/policy.mjs";

const SESSIONS_DIR = path.join(homedir(), ".pi", "agent", "sessions");
const CONFIG_KEYS = new Set(["command", "cmd", "script", "shell"]);
const PATH_KEYS = new Set(["path", "file_path", "filePath", "target", "filename", "destination"]);

function parseArgs(argv) {
  const opts = { samples: 0, list: null, max: Infinity };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--samples") opts.samples = Number(argv[++i]) || 0;
    else if (arg === "--list") opts.list = argv[++i] ?? "judge";
    else if (arg === "--max") opts.max = Number(argv[++i]) || Infinity;
  }
  return opts;
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

/** Every tool call in the corpus, in order, with the cwd it ran in. */
function readCalls(files) {
  const calls = [];
  for (const file of files) {
    let cwd;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      cwd ??= record?.cwd;
      const blocks = record?.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        if (block?.type !== "toolCall" || !block.name) continue;
        calls.push({ name: block.name, input: block.arguments ?? {}, cwd });
      }
    }
  }
  return calls;
}

function shellCommand(input) {
  if (!input || typeof input !== "object") return undefined;
  for (const key of CONFIG_KEYS) {
    if (typeof input[key] === "string") return input[key];
  }
  return undefined;
}

function firstPath(input) {
  if (!input || typeof input !== "object") return undefined;
  for (const key of PATH_KEYS) {
    if (typeof input[key] === "string") return input[key];
  }
  return undefined;
}

function preview(text, width = 100) {
  return String(text ?? "").replace(/\s+/g, " ").slice(0, width);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(SESSIONS_DIR)) {
    console.error(`No sessions directory at ${SESSIONS_DIR}`);
    process.exit(1);
  }

  const calls = readCalls(walk(SESSIONS_DIR));
  const mutating = calls.filter((c) => ["bash", "shell", "edit", "write"].includes(String(c.name).toLowerCase()));

  const counts = { allow: 0, judge: 0, confirm: 0, block: 0 };
  const reasons = new Map();
  const byVerdict = { judge: [], confirm: [], block: [] };

  for (const call of mutating) {
    // scriptTexts is passed because historical script files may no longer
    // exist: this measures the shape rules, not the reader.
    const decision = evaluateToolCall({
      toolName: call.name,
      input: call.input,
      cwd: call.cwd,
      scriptTexts: {},
    });
    counts[decision.verdict] = (counts[decision.verdict] ?? 0) + 1;
    if (decision.verdict !== "allow") {
      const key = `${decision.verdict}: ${decision.reason ?? "(no reason)"}`;
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
      if (byVerdict[decision.verdict] && byVerdict[decision.verdict].length < opts.samples) {
        byVerdict[decision.verdict].push(preview(shellCommand(call.input) ?? firstPath(call.input) ?? ""));
      }
    }
  }

  const total = mutating.length || 1;
  const pct = (n) => `${((100 * n) / total).toFixed(2)}%`;

  console.log(`corpus: ${calls.length} tool calls, ${mutating.length} mutating (bash/edit/write)\n`);
  for (const verdict of ["allow", "judge", "confirm", "block"]) {
    console.log(`  ${verdict.padEnd(8)} ${String(counts[verdict]).padStart(7)}  ${pct(counts[verdict])}`);
  }
  const judged = counts.judge + counts.confirm + counts.block;
  console.log(`\n  interrupted (judge + confirm + block): ${judged} = ${pct(judged)}`);
  console.log(`  judge calls only: ${counts.judge} = ${pct(counts.judge)}  (~1 per ${Math.round(total / Math.max(counts.judge, 1))} mutating calls)`);

  const top = [...reasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  if (top.length) {
    console.log("\ntop reasons:");
    for (const [reason, count] of top) console.log(`  ${String(count).padStart(6)}  ${reason}`);
  }

  for (const [verdict, samples] of Object.entries(byVerdict)) {
    if (!samples.length) continue;
    console.log(`\n${verdict} samples:`);
    for (const sample of samples) console.log(`  ${sample}`);
  }

  if (opts.list) {
    const wanted = opts.list === "all" ? ["judge", "confirm", "block"] : [opts.list];
    console.log(`\n--- ${opts.list} ---`);
    let shown = 0;
    for (const call of mutating) {
      const decision = evaluateToolCall({ toolName: call.name, input: call.input, cwd: call.cwd, scriptTexts: {} });
      if (!wanted.includes(decision.verdict)) continue;
      if (shown++ >= opts.max) break;
      console.log(`  [${decision.verdict}] ${preview(shellCommand(call.input) ?? firstPath(call.input) ?? "", 130)}`);
      console.log(`        ${decision.reason}`);
    }
  }
}

main();
