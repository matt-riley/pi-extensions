// sessions.mjs — read pi's session transcripts as structured turns.
//
// Three scripts now want the same thing: the corpus grouped the way the agent
// actually experienced it — one user prompt, the tool calls it caused, and the
// requests that were billed for it. Writing that walk a third time would mean
// three parsers drifting apart, so it lives here.
//
// Read-only. Nothing here executes what it reads.

import fs from "node:fs";
import path from "node:path";

/** Every `.jsonl` transcript under `dir`, recursively. */
export function findSessionFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".jsonl")) out.push(full);
    }
  };
  walk(dir);
  return out;
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join(" ");
}

function usageOf(usage) {
  if (!usage) return null;
  const input = Number(usage.input) || 0;
  const cacheRead = Number(usage.cacheRead) || 0;
  return {
    input,
    cacheRead,
    cacheWrite: Number(usage.cacheWrite) || 0,
    output: Number(usage.output) || 0,
    reasoning: Number(usage.reasoning) || 0,
    // Context the model actually read: the uncached remainder plus what the
    // provider served from cache. Providers that do not cache report it all
    // as `input`, which is the same total.
    context: input + cacheRead,
    cost: {
      total: Number(usage.cost?.total) || 0,
      input: Number(usage.cost?.input) || 0,
      output: Number(usage.cost?.output) || 0,
      cacheRead: Number(usage.cost?.cacheRead) || 0,
      cacheWrite: Number(usage.cost?.cacheWrite) || 0,
    },
  };
}

/**
 * Group one transcript into turns.
 *
 * A turn starts at a user message with text and absorbs everything the agent
 * did in response: tool calls (with their results' error flags, correlated by
 * id), billed requests, and the models involved. Compactions are reported
 * separately because they are session events, not turn events.
 */
export function readSession(file) {
  const turns = [];
  const compactions = [];
  /** Model switches, including the session start and any router escalation. */
  const modelChanges = [];
  /** Custom entries extensions persisted: telemetry that never enters context. */
  const entries = [];
  let cwd;
  let turn = null;
  let pending = new Map(); // toolCallId -> call, to attach its result

  const finish = () => {
    if (turn) turns.push(turn);
    turn = null;
    pending = new Map();
  };

  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }

    cwd ??= record.cwd;

    if (record.type === "model_change") {
      modelChanges.push({
        file,
        at: Date.parse(record.timestamp ?? "") || null,
        provider: record.provider ?? null,
        model: record.modelId ?? record.model ?? null,
      });
    }

    if (record.type === "custom" && record.customType) {
      entries.push({
        file,
        customType: record.customType,
        data: record.data ?? null,
        at: Date.parse(record.timestamp ?? "") || null,
      });
    }

    if (record.type === "compaction") {
      compactions.push({
        file,
        tokensBefore: Number(record.tokensBefore) || 0,
        fromHook: record.fromHook === true,
        summary: typeof record.summary === "string" ? record.summary : "",
      });
      continue;
    }

    const message = record.message;
    if (!message) continue;

    if (message.role === "user") {
      finish();
      const prompt = messageText(message.content).trim();
      // A user record with no text (an image-only or tool-only message) does
      // not start a turn of its own.
      if (!prompt) continue;
      turn = {
        file,
        cwd,
        prompt,
        source: record.source ?? message.source ?? null,
        // What the assistant said last in this turn. The next prompt is often
        // a reply to it ("do it bruv"), so a router that only sees prompts is
        // judging intent with the referent missing.
        lastResponse: "",
        toolCalls: [],
        requests: [],
        models: new Set(),
        contextFirst: null,
        contextLast: 0,
      };
      continue;
    }

    if (message.role === "assistant") {
      const text = messageText(message.content).trim();
      if (text && turn) turn.lastResponse = text.slice(-1500);
      const usage = usageOf(message.usage);
      if (usage && turn) {
        turn.requests.push({
          ...usage,
          model: `${message.provider ?? "?"}/${message.model ?? "?"}`,
          stopReason: message.stopReason ?? null,
        });
        turn.models.add(`${message.provider ?? "?"}/${message.model ?? "?"}`);
        turn.contextFirst ??= usage.context;
        turn.contextLast = usage.context;
      }
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block?.type !== "toolCall" || !block.name) continue;
        const call = {
          name: block.name,
          args: block.arguments ?? {},
          isError: false,
          outputChars: 0,
        };
        if (turn) turn.toolCalls.push(call);
        if (block.id) pending.set(block.id, call);
      }
      continue;
    }

    if (message.role === "toolResult") {
      const call = message.toolCallId ? pending.get(message.toolCallId) : null;
      if (call) {
        call.isError = message.isError === true;
        const blocks = Array.isArray(message.content) ? message.content : [];
        call.outputChars = blocks.reduce(
          (n, b) => n + (typeof b?.text === "string" ? b.text.length : 0),
          0,
        );
      }
    }
  }

  finish();
  return { file, cwd, turns, compactions, modelChanges, entries };
}

/** Percentile of a numeric list (0 = min, 1 = max). */
export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
}
