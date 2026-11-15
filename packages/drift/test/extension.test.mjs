import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import drift from "../index.ts";
import safeCompact from "../../safe-compact/index.ts";

function setup(t) {
  const cwd = mkdtempSync(join(tmpdir(), "drift-ext-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", ["-C", cwd, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "t");
  git("config", "user.email", "t@example.com");
  writeFileSync(join(cwd, "a.js"), "one\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const handlers = new Map();
  const busEvents = new Map();
  const pi = {
    on: (name, handler) => handlers.set(name, handler),
    events: {
      on: (name, handler) => busEvents.set(name, handler),
      emit: (name, payload) => busEvents.get(name)?.(payload),
    },
    registerTool() {},
    registerCommand() {},
    registerFlag() {},
    getFlag: () => undefined,
  };
  drift(pi);
  const ctx = { cwd };
  const prompt = async (messageType = "user") => {
    const event = { messageType, systemPromptOptions: { sections: {} } };
    await handlers.get("before_agent_start")(event, ctx);
    return event.systemPromptOptions.sections;
  };
  const settle = () => handlers.get("agent_settled")({ aborted: false }, ctx);
  return { cwd, git, handlers, pi, ctx, prompt, settle, bus: pi.events };
}

test("a change made between settle and the next prompt is named in a prompt section", async (t) => {
  const h = setup(t);
  assert.deepEqual(await h.prompt(), {}, "first prompt only baselines");
  writeFileSync(join(h.cwd, "a.js"), "own edit\n"); // the session's own work
  await h.settle();
  writeFileSync(join(h.cwd, "a.js"), "edited elsewhere\n");
  writeFileSync(join(h.cwd, "b.js"), "new\n");
  const sections = await h.prompt();
  assert.match(sections.drift, /a\.js/);
  assert.match(sections.drift, /b\.js/);
  // Reported once.
  assert.deepEqual(await h.prompt(), {});
});

test("the session's own edits before settle are not drift", async (t) => {
  const h = setup(t);
  await h.prompt();
  writeFileSync(join(h.cwd, "a.js"), "own\n");
  await h.settle();
  assert.deepEqual(await h.prompt(), {});
});

test("only user prompts are checked", async (t) => {
  const h = setup(t);
  await h.prompt();
  await h.settle();
  writeFileSync(join(h.cwd, "a.js"), "elsewhere\n");
  assert.deepEqual(await h.prompt("custom"), {});
  assert.match((await h.prompt("user")).drift, /a\.js/);
});

test("a running subagent or job pauses the check instead of blaming it for drift", async (t) => {
  const h = setup(t);
  await h.prompt();
  await h.settle();
  h.bus.emit("subagents:started", { id: "worker" });
  writeFileSync(join(h.cwd, "a.js"), "subagent wrote this\n");
  assert.deepEqual(await h.prompt(), {});
  h.bus.emit("subagents:completed", { id: "worker" });
  await h.settle();

  await h.handlers.get("tool_result")(
    { toolName: "terminal_start", details: { job: { id: "j", status: "running" } } },
    h.ctx,
  );
  writeFileSync(join(h.cwd, "a.js"), "job wrote this\n");
  assert.deepEqual(await h.prompt(), {});
});

test("an aborted run drops the baseline, so its own half-done edits are not blamed", async (t) => {
  const h = setup(t);
  await h.prompt();
  await h.settle();
  writeFileSync(join(h.cwd, "a.js"), "elsewhere\n");
  await h.handlers.get("agent_settled")({ aborted: true }, h.ctx);
  assert.deepEqual(await h.prompt(), {});
  // The next prompt baselined, so later outside changes are caught again.
  await h.settle();
  writeFileSync(join(h.cwd, "a.js"), "again\n");
  assert.match((await h.prompt()).drift, /a\.js/);
});

test("outside a git repo it stays silent", async (t) => {
  const h = setup(t);
  const plain = mkdtempSync(join(tmpdir(), "drift-plain-"));
  t.after(() => rmSync(plain, { recursive: true, force: true }));
  const ctx = { cwd: plain };
  const event = { messageType: "user", systemPromptOptions: { sections: {} } };
  await h.handlers.get("before_agent_start")(event, ctx);
  await h.handlers.get("agent_settled")({}, ctx);
  await h.handlers.get("before_agent_start")(event, ctx);
  assert.deepEqual(event.systemPromptOptions.sections, {});
});

test("the drift section shows up in safe-compact's prompt-size view", async (t) => {
  const h = setup(t);
  // Same order as the manifest: drift registers before safe-compact.
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  const order = [];
  const pi = {
    on: (name, handler) => {
      order.push(name);
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool: (d) => tools.set(d.name, d),
    registerCommand: (n, d) => commands.set(n, d),
    registerFlag() {},
    getFlag: () => undefined,
    getSettings: () => ({ compaction: {} }),
    events: { on() {}, emit() {} },
  };
  drift(pi);
  safeCompact(pi);
  const ctx = {
    ...h.ctx,
    getContextUsage: () => ({ tokens: 10, contextWindow: 1000, percent: 1 }),
  };
  const run = async (name, event) => {
    for (const handler of handlers.get(name) ?? []) await handler(event, ctx);
  };
  await run("before_agent_start", { messageType: "user", systemPromptOptions: { sections: {} } });
  await run("agent_settled", {});
  writeFileSync(join(h.cwd, "a.js"), "elsewhere\n");
  const event = { messageType: "user", systemPromptOptions: { sections: {} } };
  await run("before_agent_start", event);
  assert.ok(event.systemPromptOptions.sections.drift);
  const out = await tools.get("view_context").execute("id", {}, undefined, undefined, ctx);
  const names = JSON.parse(out.content[0].text).prompt.sections.map((s) => s.name);
  assert.ok(names.includes("drift"));
});

test("drift registers before safe-compact in the root manifest, so safe-compact sees its section", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  );
  const list = manifest.pi.extensions;
  const at = list.indexOf("./packages/drift/index.ts");
  assert.ok(at >= 0, "drift is registered");
  assert.ok(at < list.indexOf("./packages/safe-compact/index.ts"));
});
