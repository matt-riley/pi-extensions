import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findSessionFiles, percentile, readSession } from "./sessions.mjs";

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "sessions-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const transcript = (records) =>
  records
    .map((record) => (typeof record === "string" ? record : JSON.stringify(record)))
    .join("\n");

test("findSessionFiles walks nested directories and returns only .jsonl files", (t) => {
  const dir = scratch(t);
  mkdirSync(join(dir, "nested"));
  writeFileSync(join(dir, "a.jsonl"), "");
  writeFileSync(join(dir, "b.txt"), "");
  writeFileSync(join(dir, "nested", "c.jsonl"), "");
  const found = findSessionFiles(dir)
    .map((file) => file.slice(dir.length + 1))
    .sort();
  assert.deepEqual(found, ["a.jsonl", join("nested", "c.jsonl")]);
});

test("readSession groups one prompt with its calls, usage and session events", (t) => {
  const dir = scratch(t);
  const file = join(dir, "session.jsonl");
  const at = "2026-01-02T03:04:05.000Z";
  writeFileSync(
    file,
    transcript([
      { type: "message", cwd: "/repo", message: { role: "user", content: [{ type: "image" }] } },
      "{not json",
      "",
      {
        type: "message",
        cwd: "/repo",
        source: "user",
        message: { role: "user", content: "Fix the bug" },
      },
      { type: "model_change", timestamp: at, provider: "anthropic", modelId: "claude-sonnet" },
      {
        type: "message",
        message: {
          role: "assistant",
          provider: "anthropic",
          model: "claude-sonnet",
          stopReason: "toolUse",
          content: [
            { type: "text", text: "Looking" },
            { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls" } },
          ],
          usage: {
            input: 100,
            cacheRead: 20,
            cacheWrite: 5,
            output: 30,
            reasoning: 2,
            cost: { total: 0.5, input: 0.3, output: 0.1, cacheRead: 0.05, cacheWrite: 0.05 },
          },
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          isError: true,
          content: [{ type: "text", text: "boom" }],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "unknown",
          content: [{ type: "text", text: "ignored" }],
        },
      },
      { type: "custom", customType: "router", data: { model: "x" }, timestamp: at },
      { type: "compaction", tokensBefore: 1234, fromHook: true, summary: "handoff" },
    ]),
  );

  const session = readSession(file);
  assert.equal(session.file, file);
  assert.equal(session.cwd, "/repo");
  assert.equal(session.turns.length, 1);
  const [turn] = session.turns;
  assert.equal(turn.prompt, "Fix the bug");
  assert.equal(turn.source, "user");
  assert.equal(turn.lastResponse, "Looking");
  assert.deepEqual(turn.toolCalls, [
    { name: "bash", args: { command: "ls" }, isError: true, outputChars: 4 },
  ]);
  assert.deepEqual(turn.requests, [
    {
      input: 100,
      cacheRead: 20,
      cacheWrite: 5,
      output: 30,
      reasoning: 2,
      context: 120,
      cost: { total: 0.5, input: 0.3, output: 0.1, cacheRead: 0.05, cacheWrite: 0.05 },
      model: "anthropic/claude-sonnet",
      stopReason: "toolUse",
    },
  ]);
  assert.deepEqual([...turn.models], ["anthropic/claude-sonnet"]);
  assert.equal(turn.contextFirst, 120);
  assert.equal(turn.contextLast, 120);
  assert.deepEqual(session.modelChanges, [
    { file, at: Date.parse(at), provider: "anthropic", model: "claude-sonnet" },
  ]);
  assert.deepEqual(session.entries, [
    { file, customType: "router", data: { model: "x" }, at: Date.parse(at) },
  ]);
  assert.deepEqual(session.compactions, [
    { file, tokensBefore: 1234, fromHook: true, summary: "handoff" },
  ]);
});

test("a second prompt starts a new turn and late results do not cross turns", (t) => {
  const dir = scratch(t);
  const file = join(dir, "session.jsonl");
  writeFileSync(
    file,
    transcript([
      { type: "message", cwd: "/repo", message: { role: "user", content: "First" } },
      {
        type: "message",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }],
        },
      },
      { type: "message", message: { role: "user", content: "Second" } },
      { type: "message", message: { role: "assistant", content: "Answer two" } },
      {
        type: "message",
        message: { role: "toolResult", toolCallId: "call-1", isError: true, content: "late" },
      },
    ]),
  );

  const { turns } = readSession(file);
  assert.deepEqual(
    turns.map((turn) => [turn.prompt, turn.lastResponse, turn.toolCalls.length]),
    [
      ["First", "", 1],
      ["Second", "Answer two", 0],
    ],
  );
  assert.equal(turns[0].toolCalls[0].isError, false, "a result after the next prompt is dropped");
});

test("an assistant message without usage or a text block records no request", (t) => {
  const dir = scratch(t);
  const file = join(dir, "session.jsonl");
  writeFileSync(
    file,
    transcript([
      { type: "message", cwd: "/repo", message: { role: "user", content: "Hi" } },
      {
        type: "message",
        message: {
          role: "assistant",
          provider: "p",
          model: "m",
          content: [{ type: "toolCall", name: "read", arguments: { path: "a" } }],
        },
      },
    ]),
  );

  const [turn] = readSession(file).turns;
  assert.deepEqual(turn.requests, []);
  assert.deepEqual([...turn.models], []);
  assert.equal(turn.contextFirst, null);
  assert.equal(turn.contextLast, 0);
  assert.deepEqual(turn.toolCalls, [
    { name: "read", args: { path: "a" }, isError: false, outputChars: 0 },
  ]);
});

test("percentile clamps to the ends and returns 0 for no samples", () => {
  assert.equal(percentile([], 0.5), 0);
  assert.equal(percentile([3, 1, 2], 0), 1);
  assert.equal(percentile([3, 1, 2], 0.5), 2);
  assert.equal(percentile([3, 1, 2], 1), 3);
  assert.equal(percentile([4, 1, 3, 2], 0.5), 2);
});
