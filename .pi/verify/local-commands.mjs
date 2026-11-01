#!/usr/bin/env node
// Real Pi RPC acceptance for local commands; no listener, provider or credentials.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { once } from "node:events";

const root = path.resolve(import.meta.dirname, "../..");
const fixture = await mkdtemp(path.join(tmpdir(), "pi-local-commands-"));
const agent = path.join(fixture, "agent");
const cwd = path.join(fixture, "workspace");
const pending = new Map();
const events = [];
let child, lines, sequence = 0, stderr = "";
const request = (type, fields = {}) => new Promise((resolve, reject) => {
  const id = `local-${++sequence}`;
  const timer = setTimeout(() => {
    pending.delete(id);
    reject(new Error(`RPC timeout: ${type}\n${stderr}`));
  }, 10000);
  pending.set(id, { resolve, reject, timer });
  child.stdin.write(JSON.stringify({ id, type, ...fields }) + "\n");
});

try {
  await mkdir(agent);
  await mkdir(cwd);
  await writeFile(path.join(agent, "models.json"), JSON.stringify({ providers: {
    "local-check": {
      baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "unused-fixture",
      models: [{ id: "fixture", name: "No-call fixture", input: ["text"], contextWindow: 10000, maxTokens: 100 }],
    },
  } }));
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  child = spawn(process.env.PI_SMOKE_BIN ?? "pi", [
    "--mode", "rpc", "--offline", "--no-session", "--no-mcp", "--no-extensions",
    "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
    "--provider", "local-check", "--model", "fixture", "--thinking", "off",
    ...manifest.pi.extensions.flatMap((entry) => ["-e", path.resolve(root, entry)]),
    "--prompt-template", path.join(root, "prompts/workflow.md"),
  ], {
    cwd,
    env: { PATH: process.env.PATH, HOME: fixture, PI_CODING_AGENT_DIR: agent, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (data) => { stderr += data; });
  child.on("error", (error) => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); }
    pending.clear();
  });
  lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let event;
    try { event = JSON.parse(line); } catch { return; }
    events.push(event);
    const item = pending.get(event.id);
    if (event.type !== "response" || !item) return;
    clearTimeout(item.timer);
    pending.delete(event.id);
    if (event.success) item.resolve(event.data);
    else item.reject(new Error(event.error));
  });
  await request("get_state");
  const commands = await request("get_commands");
  for (const name of ["skill-search", "usage", "workflow"])
    assert.ok(commands.commands.some((command) => command.name === name), `Missing ${name}`);
  await request("prompt", { message: "/skill-search review" });
  const searched = await request("get_messages");
  const result = searched.messages.findLast((message) => message.customType === "skill-search");
  assert.match(result?.content ?? "", /implementation-review/);
  assert.match(result.content, /SKILL.md/);
  await request("prompt", { message: "/usage --json" });
  const accounted = await request("get_messages");
  const usage = accounted.messages.findLast((message) => message.customType === "usage-report");
  assert.deepEqual(JSON.parse(usage?.content ?? "null"), { requests: 0, models: [], tools: [] });
  assert.ok(!events.some((event) => event.type === "agent_start"), "Local commands started an agent");
  assert.ok(!events.some((event) => event.type === "extension_ui_request" && event.method === "select"), "RPC search opened a picker");
  assert.doesNotMatch(stderr, /failed to load|error loading/i);
  console.log(`ok: real Pi loads ${manifest.pi.extensions.length} extensions and discovers /workflow outside the repo`);
  console.log("ok: /skill-search returns an owned skill and path without RPC dialogs or model work");
  console.log("ok: /usage --json returns active-branch accounting without starting an agent");
} finally {
  for (const item of pending.values()) clearTimeout(item.timer);
  lines?.close();
  if (child && child.exitCode === null) {
    const closed = once(child, "close");
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    await closed;
    clearTimeout(timer);
  }
  await rm(fixture, { recursive: true, force: true });
}
