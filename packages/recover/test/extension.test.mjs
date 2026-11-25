import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import recover from "../index.ts";
import { JOURNAL_TYPE, NOTE_TYPE } from "../recover.mjs";

function setup() {
  const branch = [];
  const appended = [];
  const sent = [];
  const handlers = new Map();
  const pi = {
    on: (name, handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
    appendEntry: (customType, data) => {
      const entry = { type: "custom", customType, data };
      appended.push(entry);
      branch.push(entry);
    },
    sendUserMessage: (...args) => sent.push(args),
    registerTool() {},
    registerCommand() {},
    registerFlag() {},
    getFlag: () => undefined,
  };
  recover(pi);
  const ctx = { sessionManager: { getBranch: () => branch } };
  const emit = async (name, event = {}) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };
  const prompt = async (messageType = "user") => {
    const event = { messageType, systemPromptOptions: { sections: {} } };
    await emit("before_agent_start", event);
    return event.systemPromptOptions.sections;
  };
  return { branch, appended, sent, handlers, pi, ctx, emit, prompt };
}

test("a tool call is journaled before it runs and again when it finishes", async () => {
  const h = setup();
  await h.emit("tool_call", { toolCallId: "c1", toolName: "bash", input: { command: "secret" } });
  assert.equal(h.appended.length, 1);
  assert.equal(h.appended[0].customType, JOURNAL_TYPE);
  assert.equal(h.appended[0].data.phase, "started");
  assert.equal(h.appended[0].data.toolCallId, "c1");
  assert.equal(h.appended[0].data.toolName, "bash");
  assert.equal(h.appended[0].data.input, undefined);
  await h.emit("tool_result", { toolCallId: "c1", toolName: "bash", isError: false });
  assert.equal(h.appended.at(-1).data.phase, "finished");
});

test("resuming a cut-off session adds one recover note on the next user prompt", async () => {
  const h = setup();
  await h.emit("tool_call", { toolCallId: "c1", toolName: "write" });
  h.branch.push({
    type: "message",
    message: { role: "assistant", stopReason: "aborted" },
  });
  await h.emit("session_start");
  const notes = h.appended.filter((entry) => entry.customType === NOTE_TYPE);
  assert.equal(notes.length, 1);
  assert.match(notes[0].data.text, /May have partly run: write \(c1\)/);
  assert.match(notes[0].data.text, /check the current state before repeating/);
  const first = await h.prompt();
  assert.equal(first.recover, notes[0].data.text);
  assert.deepEqual(await h.prompt(), {});
  assert.equal(h.sent.length, 0);
});

test("a finished session is resumed without a recover note", async () => {
  const h = setup();
  await h.emit("tool_call", { toolCallId: "c1", toolName: "read" });
  await h.emit("tool_result", { toolCallId: "c1", toolName: "read" });
  h.branch.push({
    type: "message",
    message: { role: "assistant", stopReason: "stop" },
  });
  await h.emit("session_start");
  assert.equal(h.appended.filter((entry) => entry.customType === NOTE_TYPE).length, 0);
  assert.deepEqual(await h.prompt(), {});
  assert.equal(h.sent.length, 0);
});

test("a journal that cannot be read fails closed on resume", async () => {
  const h = setup();
  h.ctx.sessionManager.getBranch = () => {
    throw new Error("session file unreadable");
  };
  await h.emit("session_start");
  const notes = h.appended.filter((entry) => entry.customType === NOTE_TYPE);
  assert.equal(notes.length, 1);
  assert.match(notes[0].data.text, /journal is unreadable/);
  assert.match(notes[0].data.text, /check the current state before repeating/);
  assert.equal((await h.prompt()).recover, notes[0].data.text);
  assert.equal(h.sent.length, 0);
});

test("an injected follow-up does not receive the recover section", async () => {
  const h = setup();
  await h.emit("tool_call", { toolCallId: "c1", toolName: "write" });
  await h.emit("session_start");
  assert.deepEqual(await h.prompt("custom"), {});
  assert.match((await h.prompt("user")).recover, /write \(c1\)/);
});

test("recover registers before safe-compact in the root manifest", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  );
  const list = manifest.pi.extensions;
  const at = list.indexOf("./packages/recover/index.ts");
  assert.ok(at >= 0, "recover is registered");
  assert.ok(at < list.indexOf("./packages/safe-compact/index.ts"));
});
