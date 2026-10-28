// Shadow mode: log what router/auto would choose without switching models.

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import piRouterExtension from "../index.ts";
import { readShadowLines, shadowLogPath } from "../shadow-log.mjs";

const LUNA = { provider: "openai-codex", id: "gpt-5.6-luna" };
const ASTRA = { provider: "openai-codex", id: "gpt-6-astra", contextWindow: 272000 };

const ENV = {
  PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD,
  PI_ROUTER: process.env.PI_ROUTER,
};

const tempDirs = [];

function tempAgentDir(config = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "router-shadow-ext-"));
  tempDirs.push(dir);
  const file = path.join(dir, "router.json");
  const body = { shadowLog: true, ...config };
  fs.writeFileSync(file, `${JSON.stringify(body, null, 2)}\n`);
  return dir;
}

beforeEach(() => {
  for (const key of Object.keys(ENV)) delete process.env[key];
  process.env.PI_ROUTER_PLAYBOOKS = "off";
});

after(() => {
  for (const [key, value] of Object.entries(ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function harness({
  difficulty = 2.6,
  shadowLog = true,
  model = LUNA,
  thinkingLevel = "medium",
  askImpl,
  agentDir: agentDirPath,
} = {}) {
  const agentRoot = agentDirPath ?? tempAgentDir({ shadowLog });
  const configPath = path.join(agentRoot, "router.json");
  const logPath = shadowLogPath({ PI_CODING_AGENT_DIR: agentRoot });
  const commands = {};
  const handlers = {};
  const notifications = [];
  const askArgs = [];

  const pi = {
    on: (event, handler) => {
      handlers[event] = handler;
    },
    registerCommand: (name, def) => {
      commands[name] = def;
    },
    appendEntry: () => {},
    registerVirtualModel: () => {},
  };

  const ctx = {
    cwd: "/repo",
    sessionId: "shadow-test-session",
    model,
    thinkingLevel,
    modelRegistry: {
      getAvailable: () => [LUNA, ASTRA],
      find: (provider, id) =>
        [LUNA, ASTRA].find((m) => m.provider === provider && m.id === id) ?? null,
    },
    sessionManager: { getBranch: () => [] },
    ui: {
      notify: (title) => notifications.push(title),
      setStatus: () => {},
    },
  };

  const judge =
    askImpl ?? (async () => ({ answers: { difficulty: { type: "score", score: difficulty } } }));

  piRouterExtension(pi, {
    ask: async (...args) => {
      askArgs.push(args[0]);
      return judge(...args);
    },
    configPath,
  });

  return {
    logPath,
    configPath,
    notifications,
    askCount: () => askArgs.length,
    command: (args) => commands.route.handler(args, ctx),
    shadowTurn: (prompt) => handlers.before_agent_start?.({ messageType: "user", prompt }, ctx),
  };
}

test("with shadow off nothing is written", async () => {
  const agentRoot = tempAgentDir({ shadowLog: false });
  const h = harness({ agentDir: agentRoot, shadowLog: false });
  await h.shadowTurn("audit the routing design");
  assert.equal(fs.existsSync(h.logPath), false);
  assert.equal(h.askCount(), 0);
});

test("shadow on logs would-be tier without changing the selected model", async () => {
  const h = harness({ difficulty: 2.6 });
  await h.shadowTurn("audit the routing design and tell me what is wrong with it");
  assert.equal(h.askCount(), 1);
  const lines = readShadowLines(h.logPath);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].actual.key, "openai-codex/gpt-5.6-luna");
  assert.equal(lines[0].wouldBe.tier, "frontier");
  assert.match(lines[0].wouldBe.key, /gpt-6-astra/);
  const raw = fs.readFileSync(h.logPath, "utf8");
  assert.ok(!raw.includes("audit the routing"));
});

test("router/auto selected does not write shadow lines", async () => {
  const agentRoot = tempAgentDir({ shadowLog: true });
  const configPath = path.join(agentRoot, "router.json");
  const logPath = path.join(agentRoot, "router-shadow.jsonl");
  let beforeHandler;
  piRouterExtension(
    {
      on: (e, hnd) => {
        if (e === "before_agent_start") beforeHandler = hnd;
      },
      registerCommand: () => {},
      appendEntry: () => {},
      registerVirtualModel: () => {},
    },
    { configPath, ask: async () => ({ answers: { difficulty: { type: "score", score: 2.6 } } }) },
  );
  await beforeHandler?.(
    { messageType: "user", prompt: "audit the routing design" },
    {
      cwd: "/repo",
      sessionId: "sess",
      model: { provider: "router", id: "auto" },
      thinkingLevel: "medium",
      sessionManager: { getBranch: () => [] },
      modelRegistry: {
        getAvailable: () => [LUNA, ASTRA],
        find: (p, id) => [LUNA, ASTRA].find((m) => m.provider === p && m.id === id) ?? null,
      },
      ui: { notify: () => {}, setStatus: () => {} },
    },
  );
  assert.equal(fs.existsSync(logPath), false);
});

test("/route shadow on and off toggles logging", async () => {
  const agentRoot = tempAgentDir({ shadowLog: false });
  const h = harness({ agentDir: agentRoot, shadowLog: false });
  await h.shadowTurn("first prompt");
  assert.equal(fs.existsSync(h.logPath), false);
  await h.command("shadow on");
  await h.shadowTurn("audit the routing design and tell me what is wrong with it");
  assert.equal(readShadowLines(h.logPath).length, 1);
  await h.command("shadow off");
  await h.shadowTurn("another prompt entirely unrelated");
  assert.equal(readShadowLines(h.logPath).length, 1);
});

test("/route shadow report prints tier shares from the log file", async () => {
  const h = harness({ difficulty: 0.6 });
  await h.shadowTurn("what does this function do");
  await h.command("shadow report");
  const text = h.notifications.at(-1);
  assert.match(text, /1 turn/);
  assert.match(text, /base .*100%/);
});
