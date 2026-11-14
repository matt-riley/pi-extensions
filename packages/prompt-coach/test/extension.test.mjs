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
  draft = "",
  inputBox = true,
  fetchFailure = false,
  env = { OPENAI_API_KEY: "test-key" },
} = {}) {
  const commands = {};
  const entries = [];
  const sent = [];
  const notifications = [];
  const statuses = [];
  const asks = [];
  const fetchCalls = [];

  const editor = { text: draft };
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
    sessionManager: {
      getBranch: () => [{ message: { role: "user", content: lastPrompt } }],
    },
    ui: {
      ...(inputBox && {
        getEditorText: () => editor.text,
        setEditorText: (text) => {
          editor.text = text;
        },
      }),
      notify: (title, level) => notifications.push({ title, level }),
      setStatus: (id, text) => statuses.push({ id, text }),
    },
  };

  piPromptCoachExtension(pi, {
    env,
    exec: gitExec,
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      if (fetchFailure) throw new Error("model is offline");
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
    editor,
    notifications,
    statuses,
    asks,
    fetchCalls,
  };
}

test("/improve rewrites with the hosted model, verifies intent, and fills the input box", async () => {
  const h = harness({ candidate: "Fix the failing workflow on main and run npm run check." });
  await h.command("fix the failing workflow on main");

  assert.equal(h.editor.text, "Fix the failing workflow on main and run npm run check.");
  assert.deepEqual(h.sent, []);
  assert.equal(h.asks.length, 1);
  assert.equal(h.asks[0].state.original_prompt, "fix the failing workflow on main");
  assert.equal(h.entries[0].data.action, "rewritten");
  assert.equal(h.entries[0].data.placed, h.editor.text);
  assert.match(h.notifications[0].title, /input box.*press Enter/);
});

test("/improve without args uses the latest user prompt", async () => {
  const h = harness({
    lastPrompt: "make the tests green",
    candidate: "Make the tests green and report the check.",
  });
  await h.command("");
  assert.equal(h.editor.text, "Make the tests green and report the check.");
  assert.deepEqual(h.sent, []);
});

test("an existing draft stays below the rewrite", async () => {
  const h = harness({ draft: "also bump the version", candidate: "Fix the build." });
  await h.command("fix the build");
  assert.equal(h.editor.text, "Fix the build.\n\nalso bump the version");
});

test("without an input box the rewrite is shown, never auto-sent", async () => {
  const h = harness({ inputBox: false, candidate: "Fix the build." });
  await h.command("fix the build");
  assert.deepEqual(h.sent, []);
  assert.match(h.notifications[0].title, /no input box.*Fix the build\./i);
});

test("failed intent verification puts the original in the input box", async () => {
  const h = harness({ candidate: "Do something unrelated.", intent: 0.2 });
  await h.command("fix the failing workflow");
  assert.equal(h.editor.text, "fix the failing workflow");
  assert.deepEqual(h.sent, []);
  assert.equal(h.entries[0].data.action, "original-fallback");
  assert.equal(h.notifications[0].level, "warning");
});

test("hosted model failure restores the original without calling TypeSafe", async () => {
  const h = harness({ fetchFailure: true });
  await h.command("fix the workflow");
  assert.equal(h.editor.text, "fix the workflow");
  assert.deepEqual(h.sent, []);
  assert.equal(h.asks.length, 0);
  assert.equal(h.entries[0].data.action, "original-fallback");
});

test("missing prompt reports usage", async () => {
  const h = harness({ lastPrompt: "" });
  await h.command("");
  assert.deepEqual(h.sent, []);
  assert.equal(h.editor.text, "");
  assert.match(h.notifications[0].title, /Usage: \/improve/);
});

test("missing API key restores the original and says which variables to set", async () => {
  const h = harness({ env: {} });
  await h.command("fix the workflow");
  assert.equal(h.editor.text, "fix the workflow");
  assert.deepEqual(h.sent, []);
  assert.equal(h.fetchCalls.length, 0);
  assert.equal(h.asks.length, 0);
  assert.match(h.entries[0].data.rewriteError, /OPENAI_API_KEY or DEEPSEEK_API_KEY/);
});

test("the request carries the key in a header and never in the recorded decision", async () => {
  const h = harness({ env: { DEEPSEEK_API_KEY: "ds-secret" } });
  await h.command("fix the workflow");
  assert.equal(h.fetchCalls[0].options.headers.authorization, "Bearer ds-secret");
  assert.equal(JSON.stringify(h.entries).includes("ds-secret"), false);
});
