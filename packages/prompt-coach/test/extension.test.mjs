import { test } from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  cwd = "/repo",
  readFirst = null,
  env = { OPENAI_API_KEY: "test-key" },
  askImpl = null,
  confirm = null,
} = {}) {
  const commands = {};
  const entries = [];
  const sent = [];
  const notifications = [];
  const statuses = [];
  const asks = [];
  const fetchCalls = [];
  const confirms = [];

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
    cwd,
    sessionManager: {
      getBranch: () => [{ message: { role: "user", content: lastPrompt } }],
    },
    hasUI: Boolean(confirm),
    ui: {
      ...(confirm && {
        confirm: async (title, message) => {
          confirms.push({ title, message, editorAtPrompt: editor.text });
          return confirm(title, message);
        },
      }),
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
      if (readFirst && fetchCalls.length === 1) {
        const call = {
          id: "c1",
          function: { name: "read_file", arguments: JSON.stringify({ path: readFirst }) },
        };
        return { ok: true, json: async () => ({ choices: [{ message: { tool_calls: [call] } }] }) };
      }
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: candidate } }] }),
      };
    },
    ask: async (request) => {
      asks.push(request);
      if (askImpl) return askImpl(request);
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
    confirms,
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

test("files the model read are shown to the intent check and recorded", async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "coach-ext-"));
  fs.writeFileSync(path.join(cwd, "loader.mjs"), "export const retries = 1;\n");
  const h = harness({ cwd, readFirst: "loader.mjs", candidate: "Set retries in loader.mjs to 2." });
  await h.command("make the loader retry twice");
  assert.deepEqual(h.asks[0].state.repository_probe.files_read, ["loader.mjs"]);
  assert.deepEqual(h.entries[0].data.filesRead, ["loader.mjs"]);
  assert.equal(h.editor.text, "Set retries in loader.mjs to 2.");
});

test("a failed intent check says why: the original is shown with the TypeSafe error", async () => {
  const h = harness({
    candidate: "Fix the failing workflow on main and run npm run check.",
    askImpl: () => {
      throw new Error("TYPESAFE_API_KEY is not set.");
    },
  });
  await h.command("fix the failing workflow on main");
  assert.equal(h.editor.text, "fix the failing workflow on main");
  assert.equal(h.notifications[0].level, "warning");
  assert.match(h.notifications[0].title, /intent check could not run/);
  assert.match(h.notifications[0].title, /TYPESAFE_API_KEY is not set/);
  assert.equal(h.entries[0].data.intentError, "TYPESAFE_API_KEY is not set.");
});

test("a low intent score is reported with the score and the threshold", async () => {
  const h = harness({ candidate: "Do something unrelated.", intent: 0.2 });
  await h.command("fix the failing workflow");
  assert.match(h.notifications[0].title, /scored it 0\.20/);
  assert.match(h.notifications[0].title, /0\.70/);
});

test("an unusable intent answer is reported as such", async () => {
  const h = harness({
    candidate: "Fix the failing workflow.",
    askImpl: () => ({ answers: {} }),
  });
  await h.command("fix the workflow");
  assert.equal(h.editor.text, "fix the workflow");
  assert.match(h.notifications[0].title, /no usable answer/);
});

test("a model that returns the prompt as written is reported, not passed off silently", async () => {
  const h = harness({ candidate: "fix the workflow" });
  await h.command("fix the workflow");
  assert.equal(h.editor.text, "fix the workflow");
  assert.equal(h.asks.length, 0);
  assert.equal(h.entries[0].data.action, "unchanged");
  assert.equal(h.notifications[0].level, "warning");
  assert.match(h.notifications[0].title, /returned your prompt as written/);
});

const REJECTED = "Fix the failing workflow on main and run npm run check.";

test("a rejected rewrite is shown with the score and nothing is placed until Matt confirms", async () => {
  const h = harness({
    candidate: REJECTED,
    intent: 0.4,
    draft: "",
    confirm: () => true,
  });
  await h.command("fix the failing workflow on main");
  assert.equal(h.confirms.length, 1);
  assert.equal(h.confirms[0].editorAtPrompt, "");
  assert.match(h.confirms[0].message, /scored it 0\.40/);
  assert.match(h.confirms[0].message, /0\.70/);
  assert.ok(h.confirms[0].message.includes(REJECTED));
  assert.ok(h.confirms[0].message.includes("fix the failing workflow on main"));
  assert.equal(h.editor.text, REJECTED);
  assert.equal(h.entries[0].data.action, "rewritten-confirmed");
  assert.equal(h.entries[0].data.placed, REJECTED);
  assert.equal(h.entries[0].data.intentProbability, 0.4);
  assert.deepEqual(h.sent, []);
});

test("denying a rejected rewrite keeps the original", async () => {
  const h = harness({ candidate: REJECTED, intent: 0.4, confirm: () => false });
  await h.command("fix the failing workflow on main");
  assert.equal(h.confirms.length, 1);
  assert.equal(h.editor.text, "fix the failing workflow on main");
  assert.equal(h.entries[0].data.action, "kept-original");
  assert.equal(h.entries[0].data.placed, "fix the failing workflow on main");
  assert.match(h.notifications[0].title, /scored it 0\.40/);
  assert.equal(h.notifications[0].level, "warning");
});

test("a dialog that throws counts as deny", async () => {
  const h = harness({
    candidate: REJECTED,
    intent: 0.4,
    confirm: () => {
      throw new Error("dialog closed");
    },
  });
  await h.command("fix the failing workflow on main");
  assert.equal(h.editor.text, "fix the failing workflow on main");
  assert.equal(h.entries[0].data.action, "kept-original");
});

test("a failed intent check shows the error in the confirm prompt", async () => {
  const h = harness({
    candidate: REJECTED,
    confirm: () => true,
    askImpl: () => {
      throw new Error("TYPESAFE_API_KEY is not set.");
    },
  });
  await h.command("fix the failing workflow on main");
  assert.match(h.confirms[0].message, /could not run/);
  assert.match(h.confirms[0].message, /TYPESAFE_API_KEY is not set/);
  assert.equal(h.editor.text, REJECTED);
  assert.equal(h.entries[0].data.action, "rewritten-confirmed");
  assert.equal(h.entries[0].data.intentError, "TYPESAFE_API_KEY is not set.");
});

test("an unusable intent answer is also put to Matt", async () => {
  const h = harness({
    candidate: REJECTED,
    confirm: () => false,
    askImpl: () => ({ answers: {} }),
  });
  await h.command("fix the failing workflow on main");
  assert.match(h.confirms[0].message, /no usable answer/);
  assert.equal(h.editor.text, "fix the failing workflow on main");
});

test("with no UI a rejected rewrite still fails closed to the original", async () => {
  const h = harness({ candidate: REJECTED, intent: 0.4 });
  await h.command("fix the failing workflow on main");
  assert.equal(h.confirms.length, 0);
  assert.equal(h.editor.text, "fix the failing workflow on main");
  assert.equal(h.entries[0].data.action, "original-fallback");
});

test("a passing rewrite is placed without any prompt", async () => {
  const h = harness({ candidate: REJECTED, intent: 0.95, confirm: () => false });
  await h.command("fix the failing workflow on main");
  assert.equal(h.confirms.length, 0);
  assert.equal(h.editor.text, REJECTED);
  assert.equal(h.entries[0].data.action, "rewritten");
});

test("a model failure is not put to Matt: there is no rewrite to confirm", async () => {
  const h = harness({ fetchFailure: true, confirm: () => true });
  await h.command("fix the workflow");
  assert.equal(h.confirms.length, 0);
  assert.equal(h.editor.text, "fix the workflow");
});
