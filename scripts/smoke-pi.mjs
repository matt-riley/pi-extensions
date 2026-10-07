#!/usr/bin/env node
// Actual pi RPC + local deterministic model fixture. No external model calls.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const root = path.resolve(import.meta.dirname, "..");
const fixture = await mkdtemp(path.join(tmpdir(), "pi-smoke-"));
const agentDir = path.join(fixture, "agent");
const cwd = path.join(fixture, "workspace");
const events = [];
const pending = new Map();
let child;
let stderr = "";
let sequence = 0;
let phase = "blocked";
let requests = 0;
let childRequests = 0;
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  if (req.url !== "/v1/chat/completions") {
    res.writeHead(400);
    res.end("Fixture only supports chat completions");
    return;
  }
  requests++;
  const messages = body.messages ?? [];
  const last = messages.at(-1);
  const user = messages.findLast((message) => message.role === "user");
  const isChild = JSON.stringify(user?.content).includes("SMOKE_CHILD_TASK");
  if (isChild) childRequests++;
  let tool;
  let content = isChild ? "SMOKE_CHILD_OK" : "SMOKE_PARENT_OK";
  if (last?.role !== "tool" && isChild && ["verified", "failed"].includes(phase)) {
    tool = {
      name: "bash",
      arguments: { command: phase === "verified" ? "pwd" : "cat missing-smoke-file" },
    };
    content = null;
  }
  if (last?.role !== "tool" && !isChild) {
    tool =
      phase === "blocked"
        ? { name: "bash", arguments: { command: "touch smoke-blocked" } }
        : {
            name: "subagent",
            arguments: {
              agent: "scout",
              task: "SMOKE_CHILD_TASK: Reply with SMOKE_CHILD_OK. Do not call tools.",
              timeout_ms: 20000,
              ...(phase === "verified" || phase === "failed"
                ? {
                    acceptance: [
                      {
                        criterion: "Fixture command completes",
                        command: phase === "verified" ? "pwd" : "cat missing-smoke-file",
                      },
                    ],
                  }
                : {}),
            },
          };
    content = null;
  }
  const delta = tool
    ? {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: `call_${requests}`,
            type: "function",
            function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
          },
        ],
      }
    : { role: "assistant", content };
  res.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (value, reason) => ({
    id: `smoke_${requests}`,
    object: "chat.completion.chunk",
    created: 1,
    model: "fixture",
    choices: [{ index: 0, delta: value, finish_reason: reason }],
  });
  res.write(`data: ${JSON.stringify(chunk(delta, null))}\n\n`);
  res.write(`data: ${JSON.stringify(chunk({}, tool ? "tool_calls" : "stop"))}\n\n`);
  res.end("data: [DONE]\n\n");
});

function request(type, fields = {}) {
  const id = `smoke-${++sequence}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`RPC timeout: ${type}\n${stderr}`));
    }, 30000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
  });
}
async function prompt(message) {
  const start = events.length;
  await request("prompt", { message });
  if (message.startsWith("/")) return [];
  const deadline = Date.now() + 30000;
  while (!events.slice(start).some((event) => event.type === "agent_settled")) {
    if (Date.now() > deadline || child.exitCode !== null)
      throw new Error(`Agent did not settle: ${stderr}\n${JSON.stringify(events.slice(start))}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return events.slice(start);
}

try {
  await mkdir(agentDir);
  await mkdir(cwd);
  execFileSync("git", ["init", "-q"], { cwd, timeout: 10000 });
  execFileSync(
    "git",
    [
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Smoke",
      "-c",
      "user.email=smoke@example.test",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "fixture",
    ],
    { cwd, timeout: 10000 },
  );
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  await writeFile(
    path.join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        "smoke-local": {
          baseUrl,
          api: "openai-completions",
          apiKey: "fixture",
          models: [
            {
              id: "fixture",
              name: "Offline smoke fixture",
              reasoning: false,
              input: ["text"],
              contextWindow: 100000,
              maxTokens: 1000,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
  );
  await writeFile(
    path.join(agentDir, "settings.json"),
    JSON.stringify({ retry: { enabled: false }, compaction: { enabled: false } }),
  );
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const args = [
    "--mode",
    "rpc",
    "--offline",
    "--no-session",
    "--no-mcp",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-approve",
    "--provider",
    "smoke-local",
    "--model",
    "fixture",
    "--thinking",
    "off",
    ...manifest.pi.extensions.flatMap((entry) => ["-e", path.resolve(root, entry)]),
  ];
  // Allowlist environment: no inherited API credentials, extension flags, or config.
  child = spawn(process.env.PI_SMOKE_BIN || "pi", args, {
    cwd,
    env: {
      PATH: process.env.PATH,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: path.join(fixture, "sessions"),
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
      TYPESAFE_API_KEY: "fixture",
      TYPESAFE_BASE_URL: baseUrl,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr.on("data", (data) => {
    stderr += data.toString();
  });
  child.on("error", (error) => {
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(error);
    }
    pending.clear();
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    events.push(event);
    const item = pending.get(event.id);
    if (event.type === "response" && item) {
      clearTimeout(item.timer);
      pending.delete(event.id);
      if (event.success) item.resolve(event.data);
      else item.reject(new Error(event.error));
    }
  });
  await request("get_state");
  const commands = await request("get_commands");
  const names = new Set(commands.commands.map((command) => command.name));
  for (const name of ["plan", "subagents", "route", "guardrail", "safe-compact"])
    assert.ok(names.has(name), `Missing command ${name}`);
  assert.doesNotMatch(stderr, /failed to load|error loading/i);
  console.log(`ok: real host loads ${manifest.pi.extensions.length} manifest extensions`);
  await prompt("/plan start");
  const blocked = await prompt("SMOKE_BLOCK: try the requested fixture tool once.");
  assert.match(JSON.stringify(blocked), /Plan mode blocks bash/);
  await assert.rejects(access(path.join(cwd, "smoke-blocked")));
  console.log("ok: plan mode blocks harmless fixture write through real tool dispatch");
  await prompt("/plan exit");
  await prompt("/subagents on");
  phase = "child";
  const childEvents = await prompt("SMOKE_PARENT: run the fixture child once.");
  assert.ok(childRequests > 0, "Child never called the local fixture model");
  assert.match(JSON.stringify(childEvents), /SMOKE_CHILD_OK/);
  assert.match(JSON.stringify(childEvents), /completed/);
  assert.match(JSON.stringify(childEvents), /task outcome: unknown/);
  console.log(
    "ok: leave plan mode, explicitly enable subagents, complete child with unknown task outcome",
  );
  for (const expected of ["verified", "failed"]) {
    phase = expected;
    const proof = await prompt(`SMOKE_PARENT: ${expected} command contract.`);
    assert.match(JSON.stringify(proof), new RegExp(`task outcome: ${expected}`));
    console.log(
      `ok: actual child command evidence reports ${expected} separately from execution completion`,
    );
  }
  console.log(
    "Offline host smoke passed; model reasoning, UI and external providers were not tested.",
  );
} finally {
  for (const item of pending.values()) clearTimeout(item.timer);
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 2000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(fixture, { recursive: true, force: true });
}
