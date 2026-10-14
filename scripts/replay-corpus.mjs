// replay-corpus.mjs — run the guardrail policy over real session history.
//
// The regression harness for packages/guardrail: it answers "how often would
// this have interrupted me?" with a number instead of an opinion. Sessions are
// pi's own JSONL transcripts under ~/.pi/agent/sessions.
//
//   node scripts/replay-corpus.mjs                 # summary
//   node scripts/replay-corpus.mjs --samples 5     # plus examples per verdict
//   node scripts/replay-corpus.mjs --list judge    # every judged command
//   node scripts/replay-corpus.mjs --judge 40      # shadow the judged band too
//   node scripts/replay-corpus.mjs --judge 150 --judge-json out.json   # raw signals
//
// The last one is the shadow trial: the deterministic policy says which calls
// reach Jev, and this asks Jev about a sample of them, so the interruption rate
// is measured rather than assumed. It costs one request per sampled call.
//
// Read-only: it never executes what it reads.

import fs from "node:fs";
import path from "node:path";
import { homedir } from "node:os";

import { judgeToolCall } from "../packages/guardrail/judge.mjs";
import { evaluateToolCall } from "../packages/guardrail/policy.mjs";
import { memoizeAsk } from "../packages/safe-compact/plan.mjs";
import { mapPool } from "../shared/spans.mjs";
import { askSystemOne } from "../shared/systemone.mjs";

const SESSIONS_DIR = path.join(homedir(), ".pi", "agent", "sessions");
const CONFIG_KEYS = new Set(["command", "cmd", "script", "shell"]);
const PATH_KEYS = new Set(["path", "file_path", "filePath", "target", "filename", "destination"]);

function parseArgs(argv) {
  const opts = { samples: 0, list: null, max: Infinity, judge: 0, judgeJson: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--samples") opts.samples = Number(argv[++i]) || 0;
    else if (arg === "--list") opts.list = argv[++i] ?? "judge";
    else if (arg === "--max") opts.max = Number(argv[++i]) || Infinity;
    else if (arg === "--judge") opts.judge = Number(argv[i + 1]) || 40;
    else if (arg === "--judge-json") opts.judgeJson = argv[++i] ?? null;
    if (arg === "--judge" && Number(argv[i + 1])) i += 1;
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

/** Readable text of a message, however its content was shaped. */
function messageText(message) {
  const content = message?.content ?? "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "string" ? part : (part?.text ?? "")))
    .filter(Boolean)
    .join("\n");
}

/**
 * Every tool call in the corpus, in order, with the cwd it ran in and the last
 * user message before it: the request the judged band compares an action
 * against, read here the same way the live guardrail reads it from the branch.
 */
function readCalls(files) {
  const calls = [];
  for (const file of files) {
    let cwd;
    let userRequest = null;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      cwd ??= record?.cwd;
      if (record?.message?.role === "user") {
        const text = messageText(record.message).trim();
        if (text) userRequest = text.slice(0, 600);
      }
      const blocks = record?.message?.content;
      if (!Array.isArray(blocks)) continue;
      for (const block of blocks) {
        if (block?.type !== "toolCall" || !block.name) continue;
        calls.push({ name: block.name, input: block.arguments ?? {}, cwd, userRequest });
      }
    }
  }
  return calls;
}

function policyDecision(call) {
  // scriptTexts is passed because historical script files may no longer exist:
  // this measures the shape rules, not the reader.
  return evaluateToolCall({
    toolName: call.name,
    input: call.input,
    cwd: call.cwd,
    scriptTexts: {},
  });
}

/**
 * The part of a command that is the action: leading env assignments and
 * cd-chains are scaffolding. Counting them made "cd" look like what the judge
 * objected to, when it was the command after the &&.
 */
function verbOf(action) {
  const words = String(action ?? "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let index = 0;
  const separator = /^(&&|;|\|\||\|)$/;
  while (index < words.length) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) {
      index += 1;
      continue;
    }
    if (words[index] === "cd") {
      index += 1;
      while (index < words.length && !separator.test(words[index])) index += 1;
      index += 1;
      continue;
    }
    break;
  }
  return words[index] ?? "(none)";
}

function actionOf(call) {
  // The same choice the live guardrail makes: a command if there is one, the
  // call's own JSON otherwise, so an edit is judged on what it would change.
  return typeof call.input?.command === "string"
    ? call.input.command
    : JSON.stringify(call.input ?? {});
}

/**
 * Shadow the judged band: ask Jev about a sample of the calls the policy sent
 * to it, so the interruption rate is what actually happens rather than what the
 * deterministic layer alone would do.
 */
async function judgeBand(mutating, opts, policy) {
  const band = mutating
    .map((call) => ({ call, decision: policyDecision(call) }))
    .filter((entry) => entry.decision.verdict === "judge");
  if (band.length === 0) return;
  // Even stride rather than the first N: the corpus is in file order, so the
  // head is one afternoon's work, not the history.
  const stride = Math.max(1, Math.floor(band.length / Math.max(opts.judge, 1)));
  const sample = band.filter((_, index) => index % stride === 0).slice(0, opts.judge);
  const ask = memoizeAsk((request) => askSystemOne(request));
  const started = Date.now();
  const results = await mapPool(
    sample,
    async ({ call, decision }) => {
      const judged = await judgeToolCall({
        action: actionOf(call),
        toolName: call.name,
        cwd: call.cwd,
        userRequest: call.userRequest,
        policyReason: decision.reason ?? null,
        timeoutMs: 20_000,
        ask,
      });
      return { call, judged };
    },
    6,
  );
  const seconds = (Date.now() - started) / 1000;

  // Raw signals, kept so a candidate threshold can be scored offline against
  // the production router instead of paying for the same judgments twice.
  const records = results.map(({ call, judged }) => ({
    action: String(actionOf(call)).slice(0, 400),
    verdict: judged.judged === false ? null : (judged.verdict ?? null),
    reason: judged.reason ?? null,
    signals: judged.signals ?? null,
  }));
  if (opts.judgeJson) {
    fs.writeFileSync(opts.judgeJson, JSON.stringify({ sampled: records.length, records }, null, 1));
  }

  const counts = { allow: 0, confirm: 0, block: 0, unavailable: 0 };
  const samples = { allow: [], confirm: [], block: [], unavailable: [] };
  // What actually moved the verdict, so a tuning pass knows which signal to
  // touch: every judgement at or above the judge's own 0.5 cut, and the leading
  // word of the action it fired on.
  const bySignal = new Map();
  const byVerb = new Map();
  const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
  for (const { call, judged } of results) {
    if (judged.verdict !== "allow") bump(byVerb, verbOf(actionOf(call)));
    for (const [name, value] of Object.entries(judged.signals ?? {})) {
      if (typeof value === "number" && value >= 0.5) bump(bySignal, name);
    }
  }
  for (const { call, judged } of results) {
    // A judge that could not answer is not a reason to interrupt: it is a hole
    // in the measurement, and counting it either way would be a fabricated one.
    const key = judged.judged === false ? "unavailable" : (judged.verdict ?? "unavailable");
    counts[key] = (counts[key] ?? 0) + 1;
    samples[key]?.push(
      preview(actionOf(call), 90) + "  — " + preview(judged.reason ?? "(no reason)", 70),
    );
  }

  const judged = counts.allow + counts.confirm + counts.block;
  const clearShare = judged > 0 ? counts.allow / judged : 0;
  const judgeCalls = policy.judge ?? 0;
  const withJudge = policy.confirm + policy.block + judgeCalls * (1 - clearShare);
  const total = mutating.length || 1;
  const pct = (n) => ((100 * n) / total).toFixed(2) + "%";

  console.log(
    "\njudged band: " +
      band.length +
      " of " +
      mutating.length +
      " mutating calls reach the judge; sampled " +
      sample.length +
      " (every " +
      stride +
      ")",
  );
  console.log(
    "  judged " + judged + ", unavailable " + counts.unavailable + ", " + seconds.toFixed(1) + "s",
  );
  console.log(
    "  cleared   " +
      String(counts.allow).padStart(4) +
      "  " +
      (100 * clearShare).toFixed(1) +
      "%   (no interruption after all)",
  );
  console.log("  confirm   " + String(counts.confirm).padStart(4));
  console.log("  block     " + String(counts.block).padStart(4));
  console.log(
    "\n  interrupted: " +
      (policy.confirm + policy.block + judgeCalls) +
      " with the policy alone (" +
      pct(policy.confirm + policy.block + judgeCalls) +
      ") → about " +
      Math.round(withJudge) +
      " with the judge (" +
      pct(withJudge) +
      ")",
  );
  const top = (map, limit = 5) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  if (bySignal.size > 0) {
    console.log("\nsignals at or above 0.5, across every non-cleared call:");
    for (const [name, count] of top(bySignal, 6)) {
      console.log("  " + String(count).padStart(4) + "  " + name);
    }
    console.log("actions that drew them:");
    for (const [verb, count] of top(byVerb)) {
      console.log("  " + String(count).padStart(4) + "  " + verb);
    }
  }
  for (const [verdict, list] of Object.entries(samples)) {
    if (list.length === 0) continue;
    console.log("\n" + verdict + " samples:");
    for (const line of list.slice(0, opts.samples || 3)) console.log("  " + line);
  }
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
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .slice(0, width);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(SESSIONS_DIR)) {
    console.error(`No sessions directory at ${SESSIONS_DIR}`);
    process.exit(1);
  }

  const calls = readCalls(walk(SESSIONS_DIR));
  const mutating = calls.filter((c) =>
    ["bash", "shell", "edit", "write"].includes(String(c.name).toLowerCase()),
  );

  const counts = { allow: 0, judge: 0, confirm: 0, block: 0 };
  const reasons = new Map();
  const byVerdict = { judge: [], confirm: [], block: [] };

  for (const call of mutating) {
    const decision = policyDecision(call);
    counts[decision.verdict] = (counts[decision.verdict] ?? 0) + 1;
    if (decision.verdict !== "allow") {
      const key = `${decision.verdict}: ${decision.reason ?? "(no reason)"}`;
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
      if (byVerdict[decision.verdict] && byVerdict[decision.verdict].length < opts.samples) {
        byVerdict[decision.verdict].push(
          preview(shellCommand(call.input) ?? firstPath(call.input) ?? ""),
        );
      }
    }
  }

  const total = mutating.length || 1;
  const pct = (n) => `${((100 * n) / total).toFixed(2)}%`;

  console.log(
    `corpus: ${calls.length} tool calls, ${mutating.length} mutating (bash/edit/write)\n`,
  );
  for (const verdict of ["allow", "judge", "confirm", "block"]) {
    console.log(
      `  ${verdict.padEnd(8)} ${String(counts[verdict]).padStart(7)}  ${pct(counts[verdict])}`,
    );
  }
  const judged = counts.judge + counts.confirm + counts.block;
  console.log(`\n  interrupted (judge + confirm + block): ${judged} = ${pct(judged)}`);
  console.log(
    `  judge calls only: ${counts.judge} = ${pct(counts.judge)}  (~1 per ${Math.round(total / Math.max(counts.judge, 1))} mutating calls)`,
  );

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

  if (opts.judge > 0) {
    if (!process.env.TYPESAFE_API_KEY) {
      console.error(
        "\n--judge needs TYPESAFE_API_KEY: without it every call reads as unavailable.",
      );
      process.exitCode = 1;
    } else {
      await judgeBand(mutating, opts, counts);
    }
  }

  if (opts.list) {
    const wanted = opts.list === "all" ? ["judge", "confirm", "block"] : [opts.list];
    console.log(`\n--- ${opts.list} ---`);
    let shown = 0;
    for (const call of mutating) {
      const decision = policyDecision(call);
      if (!wanted.includes(decision.verdict)) continue;
      if (shown++ >= opts.max) break;
      console.log(
        `  [${decision.verdict}] ${preview(shellCommand(call.input) ?? firstPath(call.input) ?? "", 130)}`,
      );
      console.log(`        ${decision.reason}`);
    }
  }
}

await main();
