import { test } from "node:test";
import assert from "node:assert/strict";

import piPromptCoachExtension from "../index.ts";

const noul = (value) => ({ type: "noul", noul: value });

async function gitExec(cmd, args) {
  if (cmd !== "git") return { code: 1, stdout: "", stderr: "" };
  if (args[0] === "rev-parse") return { code: 0, stdout: "main\n", stderr: "" };
  if (args[0] === "status") return { code: 0, stdout: " M package.json\n", stderr: "" };
  if (args[0] === "log") return { code: 0, stdout: "abc1234 current\n", stderr: "" };
  return { code: 1, stdout: "", stderr: "" };
}

function harness({
  candidate = "Improved prompt.",
  intent = 0.95,
  lastPrompt = "previous prompt",
  idle = true,
  fetchFailure = false,
} = {}) {
  const commands = {};
  const entries = [];
  const sent = [];
  const notifications = [];
  const statuses = [];
  const asks = [];
  const fetchCalls = [];

  const pi = {
    registerCommand: (name, definition) => {
      commands[name] = definition;
    },
    appendEntry: (customType, data) => entries.push({ customType, data }),
    sendUserMessage: async (text) => sent.push(text),
    exec: gitExec,
  };
  const ctx = {
    cwd: "/repo",
    isIdle: () => idle,
    sessionManager: {
      getBranch: () => [{ message: { role: "user", content: lastPrompt } }],
    },
    ui: {
      notify: (title, level) => notifications.push({ title, level }),
      setStatus: (id, text) => statuses.push({ id, text }),
    },
  };

  piPromptCoachExtension(pi, {
    exec: gitExec,
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      if (fetchFailure) throw new Error("Gemma4 is offline");
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: candidate } }] }),
      };
    },
    ask: async (request) => {
      asks.push(request);
      return { answers: { intent_preserved: noul(intent) } };
    },
  });

  return {
    command: (args) => commands.improve.handler(args, ctx),
    entries,
    sent,
    notifications,
    statuses,
    asks,
    fetchCalls,
  };
}

test("/improve rewrites locally, verifies intent, and sends the rewrite", async () => {
  const h = harness({ candidate: "Fix the failing workflow on main and run npm run check." });
  await h.command("fix the failing workflow on main");

  assert.deepEqual(h.sent, ["Fix the failing workflow on main and run npm run check."]);
  assert.equal(h.asks.length, 1);
  assert.equal(h.asks[0].state.original_prompt, "fix the failing workflow on main");
  assert.equal(h.entries[0].data.action, "rewritten");
  assert.equal(h.entries[0].data.sent, h.sent[0]);
  assert.match(h.notifications[0].title, /Improved prompt sent/);
});

test("/improve without args uses the latest user prompt", async () => {
  const h = harness({
    lastPrompt: "make the tests green",
    candidate: "Make the tests green and report the check.",
  });
  await h.command("");
  assert.deepEqual(h.sent, ["Make the tests green and report the check."]);
});

test("failed intent verification sends the original prompt", async () => {
  const h = harness({ candidate: "Do something unrelated.", intent: 0.2 });
  await h.command("fix the failing workflow");
  assert.deepEqual(h.sent, ["fix the failing workflow"]);
  assert.equal(h.entries[0].data.action, "original-fallback");
});

test("local Gemma failure sends the original without calling TypeSafe", async () => {
  const h = harness({ fetchFailure: true });
  await h.command("fix the workflow");
  assert.deepEqual(h.sent, ["fix the workflow"]);
  assert.equal(h.asks.length, 0);
  assert.equal(h.entries[0].data.action, "original-fallback");
});

test("busy agent does not submit a second turn", async () => {
  const h = harness({ idle: false });
  await h.command("fix the workflow");
  assert.deepEqual(h.sent, []);
  assert.match(h.notifications[0].title, /waits until the agent is idle/);
});

test("missing prompt reports usage", async () => {
  const h = harness({ lastPrompt: "" });
  await h.command("");
  assert.deepEqual(h.sent, []);
  assert.match(h.notifications[0].title, /Usage: \/improve/);
});
