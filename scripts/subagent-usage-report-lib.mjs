import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { tokensFromUsage } from "../packages/subagents/result.mjs";
import { findSessionFiles, percentile } from "./lib/sessions.mjs";

// Choice indexes match Object.keys order of triageQuestions() criteria in
// packages/subagents/judge.mjs. The ledger stores that index, never the label.
const TRIAGE_LABELS = ["answered", "partial", "blocked", "off_task"];

/** Ledger `answers.outcome.choice` → triage label. Anything else is no label. */
export function triageLabel(choice) {
  if (typeof choice !== "number" || !Number.isInteger(choice)) return null;
  return TRIAGE_LABELS[choice] ?? null;
}

/**
 * Which subagents judgment a ledger entry is, from the question ids
 * `buildLedgerEntry` keeps. The label text is not stored.
 */
export function judgmentKind(questions) {
  if (!Array.isArray(questions)) return null;
  const ids = new Set(questions.map((question) => question?.id));
  if (ids.has("outcome")) return "triage";
  if (ids.has("out_of_scope")) return "scope";
  if (ids.has("self_contained")) return "preflight";
  return null;
}

function emptyTriage() {
  return { answered: 0, partial: 0, blocked: 0, off_task: 0 };
}

function rank(values) {
  const nums = values.filter((value) => Number.isFinite(value));
  if (!nums.length) return { p50: null, p90: null };
  return { p50: percentile(nums, 0.5), p90: percentile(nums, 0.9) };
}

function spawnTokens(spawn) {
  if (!spawn.usage) return null;
  return tokensFromUsage(spawn.usage);
}

function spawnDuration(spawn) {
  if (spawn.start == null || spawn.end == null) return null;
  const duration = spawn.end - spawn.start;
  return duration >= 0 ? duration : null;
}

/** Stable join key. The path itself never leaves this function. */
function pathKey(filePath, cwd) {
  const trimmed = String(filePath).trim();
  if (!trimmed) return null;
  let normalized = path.normalize(trimmed);
  if (!path.isAbsolute(normalized) && cwd) normalized = path.resolve(cwd, normalized);
  else if (path.isAbsolute(normalized)) normalized = path.resolve(normalized);
  return createHash("sha256").update(normalized).digest("hex");
}

function readKeys(message, cwd) {
  const keys = [];
  for (const block of Array.isArray(message?.content) ? message.content : []) {
    if (block?.type !== "toolCall" || block.name !== "read") continue;
    const filePath = argsOf(block).path;
    if (typeof filePath !== "string") continue;
    const key = pathKey(filePath, cwd);
    if (key) keys.push(key);
  }
  return keys;
}

function transcriptOf(message) {
  const fromDetails = message?.details?.transcript;
  if (typeof fromDetails === "string" && fromDetails.trim()) return fromDetails.trim();
  const match = textOf(message?.content).match(/(?:^|\n)transcript: ([^\n]+)/);
  return match ? match[1].trim() : null;
}

function childReadKeys(transcript, sessionFile, cwd) {
  if (!transcript) return [];
  const full = path.isAbsolute(transcript)
    ? transcript
    : path.resolve(path.dirname(sessionFile), transcript);
  const keys = [];
  for (const record of readRecords(full)) {
    const message = record?.type === "message" ? record.message : record?.role ? record : null;
    if (message?.role !== "assistant") continue;
    keys.push(...readKeys(message, cwd));
  }
  return keys;
}

function parentReadKeys(records, fromIndex, cwd) {
  const keys = [];
  for (let index = fromIndex + 1; index < records.length; index += 1) {
    const message = records[index]?.type === "message" ? records[index].message : null;
    if (!message) continue;
    if (message.role === "user") break;
    if (message.role === "assistant") keys.push(...readKeys(message, cwd));
  }
  return keys;
}

function sharesRead(childKeys, parentKeys) {
  if (!childKeys.length || !parentKeys.length) return false;
  const child = new Set(childKeys);
  return parentKeys.some((key) => child.has(key));
}

function timeOf(record) {
  const raw = record?.timestamp ?? record?.message?.timestamp;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function argsOf(call) {
  const raw = call?.arguments ?? call?.args;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return raw && typeof raw === "object" ? raw : {};
}

function readRecords(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const records = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A torn line is not a spawn. Skip it.
    }
  }
  return records;
}

/** Two or more children that all started before the first of them finished. */
function markFanout(spawns) {
  const sorted = [...spawns].sort((left, right) => {
    const delta = (left.start ?? 0) - (right.start ?? 0);
    return delta || left.order - right.order;
  });
  let index = 0;
  while (index < sorted.length) {
    const group = [sorted[index]];
    let firstEnd = sorted[index].end;
    let next = index + 1;
    while (next < sorted.length) {
      const spawn = sorted[next];
      const sameBatch = spawn.batch === group[0].batch;
      const startedBeforeFirstFinish =
        spawn.start != null && firstEnd != null && spawn.start < firstEnd;
      if (!sameBatch && !startedBeforeFirstFinish) break;
      group.push(spawn);
      if (spawn.end != null)
        firstEnd = firstEnd == null ? spawn.end : Math.min(firstEnd, spawn.end);
      next += 1;
    }
    const fanout = group.length >= 2;
    for (const spawn of group) spawn.fanout = fanout;
    index = next;
  }
}

function spawnsFromFile(file) {
  const records = readRecords(file);
  const spawns = [];
  const open = [];
  const triageQueue = [];
  let batch = 0;
  let order = 0;
  let cwd = null;

  for (const [index, record] of records.entries()) {
    if (record?.type === "session" && typeof record.cwd === "string") cwd = record.cwd;
    else if (!cwd && typeof record?.cwd === "string") cwd = record.cwd;
    if (record?.type === "custom" && record.customType === "jev-decision") {
      const data = record.data;
      if (data?.feature !== "subagents" || data.outcome !== "ok") continue;
      if (judgmentKind(data.questions) !== "triage") continue;
      const label = triageLabel(data.answers?.outcome?.choice);
      if (label) triageQueue.push(label);
      continue;
    }

    const message = record?.type === "message" ? record.message : null;
    if (!message) continue;

    if (message.role === "assistant") {
      const calls = (Array.isArray(message.content) ? message.content : []).filter(
        (block) => block?.type === "toolCall" && block.name === "subagent",
      );
      if (!calls.length) continue;
      batch += 1;
      const start = timeOf(record);
      for (const call of calls) {
        const type = String(argsOf(call).agent ?? "")
          .trim()
          .toLowerCase();
        if (!type) continue;
        const spawn = {
          id: call.id ?? null,
          type,
          batch,
          order: order++,
          start,
          end: null,
          triage: null,
          fanout: false,
          usage: null,
          lossy: false,
        };
        spawns.push(spawn);
        open.push(spawn);
      }
      continue;
    }

    if (message.role !== "toolResult" || message.toolName !== "subagent") continue;
    const spawn = message.toolCallId
      ? (open.find((item) => item.id === message.toolCallId) ?? null)
      : (open[0] ?? null);
    if (!spawn) continue;
    open.splice(open.indexOf(spawn), 1);
    const body = textOf(message.content);
    if (message.isError === true || body.startsWith("Task rejected:")) {
      spawns.splice(spawns.indexOf(spawn), 1);
      continue;
    }
    spawn.end = timeOf(record);
    spawn.usage = message.usage && typeof message.usage === "object" ? message.usage : null;
    spawn.resultIndex = index;
    spawn.transcript = transcriptOf(message);
    spawn.cwd = cwd;
    if (triageQueue.length) spawn.triage = triageQueue.shift();
  }

  for (const spawn of spawns) {
    const child = childReadKeys(spawn.transcript, file, spawn.cwd);
    const parent = parentReadKeys(records, spawn.resultIndex ?? -1, spawn.cwd);
    spawn.lossy = sharesRead(child, parent);
  }

  markFanout(spawns);
  return spawns;
}

function newestStamp(records, file) {
  let newest = null;
  for (const record of records) {
    const time = timeOf(record);
    if (time != null && (newest == null || time > newest)) newest = time;
  }
  if (newest != null) return newest;
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function selectSessionFiles(files, { since, limit }) {
  const rows = [];
  for (const file of files) {
    const records = readRecords(file);
    if (!records.some((record) => typeof record?.type === "string")) continue;
    const stamp = newestStamp(records, file);
    if (since != null && stamp < since) continue;
    rows.push({ file, stamp });
  }
  rows.sort((left, right) => right.stamp - left.stamp || left.file.localeCompare(right.file));
  const chosen = limit == null ? rows : rows.slice(0, limit);
  return chosen.map((row) => row.file);
}

/** Built-in agent types, from the names of packages/subagents/agents/*.md. */
export function builtinAgentTypes(dir) {
  const agentsDir = dir ?? path.join(import.meta.dirname, "../packages/subagents/agents");
  if (!fs.existsSync(agentsDir)) return [];
  return fs
    .readdirSync(agentsDir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.basename(name, ".md"))
    .sort();
}

function listSessions(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  try {
    return findSessionFiles(dir);
  } catch {
    return [];
  }
}

/**
 * Counts for one sessions directory. `builtins` are always listed, even at zero.
 * Other agent names seen on a real `subagent` call are appended.
 */
export function buildReport({ dir, files, builtins = [], since = null, limit = null } = {}) {
  const sessionFiles = selectSessionFiles(files ?? listSessions(dir), { since, limit });
  const spawns = sessionFiles.flatMap((file) =>
    spawnsFromFile(file).filter(
      (spawn) => since == null || (spawn.start != null && spawn.start >= since),
    ),
  );
  const names = [...builtins];
  for (const spawn of spawns) {
    if (!names.includes(spawn.type)) names.push(spawn.type);
  }
  const types = names.map((type) => {
    const rows = spawns.filter((spawn) => spawn.type === type);
    const triage = emptyTriage();
    for (const row of rows) {
      if (row.triage) triage[row.triage] += 1;
    }
    return {
      type,
      spawns: rows.length,
      lone: rows.filter((row) => !row.fanout).length,
      fanout: rows.filter((row) => row.fanout).length,
      triage,
      tokens: rank(rows.map(spawnTokens)),
      durationMs: rank(rows.map(spawnDuration)),
      lossyHandoffs: rows.filter((row) => row.lossy).length,
    };
  });
  const foldCandidates = types
    .filter((row) => {
      if (row.lone <= row.fanout) return false;
      const weak = row.triage.partial + row.triage.blocked;
      const other = row.triage.answered + row.triage.off_task;
      return weak > other;
    })
    .map((row) => row.type);
  return {
    sessions: sessionFiles.length,
    spawns: spawns.length,
    types,
    foldCandidates,
    definitions: REPORT_DEFINITIONS,
  };
}

const REPORT_DEFINITIONS = {
  fanout:
    "Fan-out: two or more children that all started before the first of them finished. " +
    "Every other spawn is lone sequential. Start is the assistant message that issued the " +
    "call; end is its tool result. Calls issued in one assistant message share a start.",
  lossyHandoff:
    "Lossy handoff: after a child returns, and before the next user message, the parent " +
    "calls read on a path the child also read. Paths are hashed to compare them and are " +
    "never printed. grep, bash, and a read issued in the same turn as the spawn do not " +
    "count. A missing child transcript counts as no handoff.",
  tokens:
    "Tokens are the tool-result usage total (totalTokens, otherwise input + output + " +
    "cacheRead + cacheWrite). Duration is wall-clock from the issuing assistant message " +
    "to the tool result, because usage has no duration field. That interval includes " +
    "preflight and triage. p50 and p90 use the same rank as the other session reports.",
  foldCandidate:
    "Fold candidate: more lone sequential spawns than fan-out spawns, and more partial " +
    "or blocked triage labels than answered or off_task. A tie is not enough. Types " +
    "with no triage labels are not candidates.",
};

function cell(value, width) {
  const text = value === null || value === undefined ? "–" : String(value);
  return text.padStart(width);
}

function countLabel(count, singular, plural) {
  return `${count} ${count === 1 ? singular : plural}`;
}

/** Counts and the definitions above. No prompt text, paths, or tool arguments. */
export function formatReport(report) {
  const lines = [
    `subagent usage — ${countLabel(report.sessions, "session", "sessions")}, ` +
      countLabel(report.spawns, "spawn", "spawns"),
    "",
    report.definitions?.fanout ?? REPORT_DEFINITIONS.fanout,
    report.definitions?.lossyHandoff ?? REPORT_DEFINITIONS.lossyHandoff,
    report.definitions?.tokens ?? REPORT_DEFINITIONS.tokens,
    "",
    [
      "type".padEnd(14),
      cell("spawns", 6),
      cell("lone", 6),
      cell("fan-out", 7),
      cell("answered", 9),
      cell("partial", 8),
      cell("blocked", 8),
      cell("off_task", 8),
      cell("tok p50", 8),
      cell("tok p90", 8),
      cell("ms p50", 8),
      cell("ms p90", 8),
      cell("lossy", 6),
    ].join(" "),
  ];
  for (const row of report.types ?? []) {
    lines.push(
      [
        String(row.type).padEnd(14),
        cell(row.spawns, 6),
        cell(row.lone, 6),
        cell(row.fanout, 7),
        cell(row.triage?.answered, 9),
        cell(row.triage?.partial, 8),
        cell(row.triage?.blocked, 8),
        cell(row.triage?.off_task, 8),
        cell(row.tokens?.p50, 8),
        cell(row.tokens?.p90, 8),
        cell(row.durationMs?.p50, 8),
        cell(row.durationMs?.p90, 8),
        cell(row.lossyHandoffs, 6),
      ].join(" "),
    );
  }
  lines.push("");
  lines.push("fold candidates");
  lines.push(report.definitions?.foldCandidate ?? REPORT_DEFINITIONS.foldCandidate);
  const candidates = report.foldCandidates ?? [];
  if (!candidates.length) lines.push("  none");
  for (const type of candidates) lines.push(`  ${type}`);
  return lines.join("\n");
}
