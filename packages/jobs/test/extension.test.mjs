import test from "node:test";
import assert from "node:assert/strict";
import { installJobs } from "../extension.mjs";
import { widgets } from "../../workbench/test/ui-fixture.mjs";

function harness(t) {
  const tools = new Map(),
    commands = new Map(),
    handlers = new Map();
  const messages = [],
    notices = [];
  const ctx = {
    cwd: process.cwd(),
    mode: "rpc",
    isIdle: () => true,
    ui: { notify: (text) => notices.push(text), setStatus() {} },
  };
  const pi = {
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand: (name, command) => commands.set(name, command),
    on: (name, callback) => handlers.set(name, callback),
    sendMessage: (message, options) => messages.push({ message, options }),
  };
  installJobs(pi, widgets);
  t.after(() => handlers.get("session_shutdown")?.({}, ctx));
  const call = (name, input = {}, signal) =>
    tools.get(name).execute("call-" + name, input, signal, undefined, ctx);
  return { tools, commands, handlers, ctx, call, messages, notices };
}

test("all terminal tools stay deferred and advertise their actual effects", (t) => {
  const h = harness(t);
  assert.equal(h.tools.size, 5);
  assert.ok(h.commands.has("jobs"));
  for (const tool of h.tools.values()) {
    assert.equal(tool.exposure, "deferred");
    assert.ok(tool.outputSchema);
    assert.equal(tool.namespace.name, "terminal");
    assert.equal(
      tool.annotations.readOnlyHint,
      ["terminal_read", "terminal_list"].includes(tool.name),
    );
  }
});

test("tool results expose structured lifecycle data and preserve a real failed exit", async (t) => {
  const h = harness(t);
  const start = await h.call("terminal_start", { command: "sleep 0.05; printf fixture; exit 7" });
  const id = start.structuredContent.id;
  assert.equal(start.structuredContent.status, "running");
  assert.notEqual(start.details.job, undefined);
  assert.equal(start.details.job.version, 1);
  const result = await h.call("terminal_read", { id, wait_seconds: 2 });
  assert.equal(result.structuredContent.exit_code, 7);
  assert.equal(result.structuredContent.output, "fixture");
  assert.equal(result.isError, true);
  const listed = await h.call("terminal_list");
  assert.equal(listed.structuredContent.jobs[0].id, id);
  assert.equal(listed.structuredContent.jobs[0].output, "");
  assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].options.deliverAs, "followUp");
  assert.equal(h.messages[0].options.triggerTurn, true);
  assert.match(h.messages[0].message.content, /not.*verification/i);
});

test("log tails are bounded in both model content and persisted evidence", async (t) => {
  const h = harness(t);
  const start = await h.call("terminal_start", { command: "printf '%20000s' x", notify: false });
  const result = await h.call("terminal_read", { id: start.structuredContent.id, wait_seconds: 2 });
  assert.equal(result.structuredContent.output.length, 12000);
  assert.equal(result.details.job.output.length, 12000);
  assert.equal(result.details.job.truncated, true);
});

test("stop can forget an owned job; invalid ids never address arbitrary processes", async (t) => {
  const h = harness(t);
  const started = await h.call("terminal_start", { command: "sleep 30", notify: false });
  const id = started.structuredContent.id;
  const stopped = await h.call("terminal_stop", { id, forget: true });
  assert.equal(stopped.structuredContent.status, "stopped");
  assert.equal((await h.call("terminal_list")).structuredContent.jobs.length, 0);
  await assert.rejects(h.call("terminal_read", { id: String(process.pid) }), /Unknown job/);
});

test("human slash commands launch directly without an unsolicited model turn", async (t) => {
  const h = harness(t);
  await h.commands.get("jobs").handler("run printf human", h.ctx);
  const list = (await h.call("terminal_list")).structuredContent.jobs;
  assert.equal(list.length, 1);
  const result = await h.call("terminal_read", { id: list[0].id, wait_seconds: 2 });
  assert.equal(result.structuredContent.output, "human");
  assert.equal(h.messages.length, 0);
  assert.match(h.notices[0], /started/i);
});
