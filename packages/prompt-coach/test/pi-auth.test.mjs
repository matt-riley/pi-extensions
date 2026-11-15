import { test } from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import piPromptCoachExtension from "../index.ts";
import { rewriteWithModel } from "../rewrite.mjs";

const model = (provider, id) => ({ provider, id, api: "stub" });
const LUNA_CODEX = model("openai-codex", "gpt-6-luna");
const LUNA_API = model("openai", "gpt-6-luna");
const FLASH = model("deepseek", "deepseek-flash");

const assistant = (content, extra = {}) => ({
  role: "assistant",
  content,
  stopReason: "stop",
  ...extra,
});
const text = (value) => assistant([{ type: "text", text: value }]);
const toolUse = (id, name, args) =>
  assistant([{ type: "toolCall", id, name, arguments: args }], { stopReason: "toolUse" });

/**
 * A stand-in for Pi's ctx.modelRegistry. It lists the models Pi has auth for and
 * answers streamSimple. Anything that would hand back a raw credential throws,
 * so a test fails if the extension ever asks for one.
 */
function fakeRegistry(available, replies) {
  const calls = [];
  return {
    calls,
    getAvailable: () => available,
    find: (provider, id) => available.find((m) => m.provider === provider && m.id === id),
    isUsingOAuth: (picked) => picked.provider === "openai-codex",
    getApiKeyForProvider: () => {
      throw new Error("must not ask for a raw key");
    },
    getApiKeyAndHeaders: () => {
      throw new Error("must not ask for a raw key");
    },
    getProviderAuth: () => {
      throw new Error("must not ask for a raw key");
    },
    streamSimple: (picked, context, options) => {
      calls.push({ model: picked, context, options });
      const step = replies[Math.min(calls.length - 1, replies.length - 1)];
      const reply = typeof step === "function" ? step(context) : step;
      return { result: async () => reply };
    },
  };
}

const noFetch = async () => {
  throw new Error("fetch must not be called");
};

test("with no env key, the model comes from Pi's registry and is called through it", async () => {
  const registry = fakeRegistry([LUNA_CODEX], [text("Fix the workflow and run npm test.")]);
  const result = await rewriteWithModel({
    prompt: "fix the workflow",
    probe: { branch: "main" },
    env: {},
    fetchImpl: noFetch,
    modelRegistry: registry,
  });
  assert.equal(result.text, "Fix the workflow and run npm test.");
  assert.equal(result.model, "openai-codex/gpt-6-luna");
  assert.equal(result.source, "pi");
  assert.equal(result.subscription, true);
  assert.equal(registry.calls.length, 1);
  const [call] = registry.calls;
  assert.equal(call.model, LUNA_CODEX);
  assert.match(call.context.systemPrompt, /Return only the replacement prompt/);
  assert.equal(call.context.messages[0].role, "user");
  assert.match(JSON.stringify(call.context.messages[0].content), /fix the workflow/);
  assert.equal(call.options.reasoning, undefined, "thinking stays off");
  assert.ok(call.options.signal, "the deadline is passed to the call");
});

test("Luna on Pi's openai provider is preferred, then legacy openai-codex, then DeepSeek", async () => {
  const pick = async (available) => {
    const registry = fakeRegistry(available, [text("ok")]);
    await rewriteWithModel({ prompt: "x", env: {}, fetchImpl: noFetch, modelRegistry: registry });
    return registry.calls[0].model;
  };
  assert.equal(await pick([FLASH, LUNA_CODEX, LUNA_API]), LUNA_API);
  assert.equal(await pick([FLASH, LUNA_CODEX]), LUNA_CODEX);
  assert.equal(await pick([FLASH]), FLASH);
});

test("PI_PROMPT_COACH_PROVIDER and _MODEL choose from the models Pi has auth for", async () => {
  const flashOnly = fakeRegistry([LUNA_CODEX, FLASH], [text("ok")]);
  await rewriteWithModel({
    prompt: "x",
    env: { PI_PROMPT_COACH_PROVIDER: "deepseek" },
    fetchImpl: noFetch,
    modelRegistry: flashOnly,
  });
  assert.equal(flashOnly.calls[0].model, FLASH);

  const other = model("openai-codex", "gpt-6-sol");
  const custom = fakeRegistry([LUNA_CODEX, other], [text("ok")]);
  await rewriteWithModel({
    prompt: "x",
    env: { PI_PROMPT_COACH_MODEL: "gpt-6-sol" },
    fetchImpl: noFetch,
    modelRegistry: custom,
  });
  assert.equal(custom.calls[0].model, other);
});

test("a requested provider with no Pi login says so instead of using another", async () => {
  const registry = fakeRegistry([LUNA_CODEX], [text("ok")]);
  await assert.rejects(
    rewriteWithModel({
      prompt: "x",
      env: { PI_PROMPT_COACH_PROVIDER: "deepseek" },
      fetchImpl: noFetch,
      modelRegistry: registry,
    }),
    /\/login deepseek.*DEEPSEEK_API_KEY/,
  );
  assert.equal(registry.calls.length, 0);
});

test("an API key in the environment wins over Pi's registry", async () => {
  const registry = fakeRegistry([LUNA_CODEX], [text("from registry")]);
  const seen = [];
  const result = await rewriteWithModel({
    prompt: "x",
    env: { DEEPSEEK_API_KEY: "ds-env" },
    modelRegistry: registry,
    fetchImpl: async (url, options) => {
      seen.push({ url, options });
      return { ok: true, json: async () => ({ choices: [{ message: { content: "from env" } }] }) };
    },
  });
  assert.equal(result.text, "from env");
  assert.equal(result.source, "env");
  assert.equal(result.model, "deepseek/deepseek-flash");
  assert.equal(result.subscription, false);
  assert.equal(registry.calls.length, 0);
  assert.equal(seen[0].url, "https://api.deepseek.com/chat/completions");
  assert.equal(seen[0].options.headers.authorization, "Bearer ds-env");
});

test("no env key and no Pi login gives one message naming /login and the variables", async () => {
  for (const modelRegistry of [fakeRegistry([], [text("no")]), undefined]) {
    await assert.rejects(
      rewriteWithModel({ prompt: "x", env: {}, fetchImpl: noFetch, modelRegistry }),
      /\/login.*OPENAI_API_KEY or DEEPSEEK_API_KEY/,
    );
  }
});

test("a model with no auth in Pi is not used even if the registry knows it", async () => {
  const registry = {
    ...fakeRegistry([], [text("no")]),
    find: () => LUNA_CODEX,
  };
  await assert.rejects(
    rewriteWithModel({ prompt: "x", env: {}, fetchImpl: noFetch, modelRegistry: registry }),
    /\/login/,
  );
  assert.equal(registry.calls.length, 0);
});

test("read-only tools are offered to the registry call as Pi tools and answered", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coach-auth-"));
  fs.writeFileSync(path.join(root, "loader.mjs"), "export const retries = 1;\n");
  const registry = fakeRegistry(
    [LUNA_CODEX],
    [
      toolUse("c1", "read_file", { path: "loader.mjs" }),
      toolUse("c2", "bash", { command: "touch pwned" }),
      text("Make retries in loader.mjs 2."),
    ],
  );
  const result = await rewriteWithModel({
    prompt: "retry twice",
    cwd: root,
    env: {},
    fetchImpl: noFetch,
    modelRegistry: registry,
  });
  assert.equal(result.text, "Make retries in loader.mjs 2.");
  assert.deepEqual(result.filesRead, ["loader.mjs"]);
  assert.equal(fs.existsSync(path.join(root, "pwned")), false);
  const names = registry.calls[0].context.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["list_dir", "read_file", "search_text"]);
  assert.ok(registry.calls[0].context.tools.every((tool) => tool.parameters && tool.description));
  const last = registry.calls[2].context.messages;
  const results = last.filter((message) => message.role === "toolResult");
  assert.equal(results[0].toolCallId, "c1");
  assert.equal(results[0].toolName, "read_file");
  assert.match(results[0].content[0].text, /retries = 1/);
  assert.match(results[1].content[0].text, /not available/);
});

test("PI_PROMPT_COACH_READ_FILES=0 offers no tools through the registry", async () => {
  const registry = fakeRegistry([LUNA_CODEX], [text("ok")]);
  await rewriteWithModel({
    prompt: "x",
    cwd: "/repo",
    env: { PI_PROMPT_COACH_READ_FILES: "0" },
    fetchImpl: noFetch,
    modelRegistry: registry,
  });
  assert.equal(registry.calls[0].context.tools, undefined);
});

test("tool rounds are capped and the last registry call carries no tools", async () => {
  const registry = fakeRegistry(
    [LUNA_CODEX],
    [(context) => (context.tools ? toolUse("c", "list_dir", { path: "." }) : text("Final."))],
  );
  const result = await rewriteWithModel({
    prompt: "x",
    cwd: os.tmpdir(),
    env: {},
    fetchImpl: noFetch,
    modelRegistry: registry,
  });
  assert.equal(result.text, "Final.");
  assert.equal(registry.calls.length, 7);
  assert.equal(registry.calls[6].context.tools, undefined);
});

test("a failed or aborted registry call is reported by the provider's own message", async () => {
  const registry = fakeRegistry(
    [LUNA_CODEX],
    [assistant([], { stopReason: "error", errorMessage: "401 not logged in" })],
  );
  await assert.rejects(
    rewriteWithModel({ prompt: "x", env: {}, fetchImpl: noFetch, modelRegistry: registry }),
    /openai-codex.*401 not logged in/,
  );
});

test("the extension hands ctx.modelRegistry to the rewrite and records which model ran", async () => {
  const entries = [];
  const commands = {};
  const editor = { text: "" };
  const registry = fakeRegistry([LUNA_CODEX], [text("Improved prompt.")]);
  const pi = {
    registerCommand: (name, definition) => {
      commands[name] = definition;
    },
    appendEntry: (customType, data) => entries.push({ customType, data }),
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
  };
  piPromptCoachExtension(pi, {
    env: {},
    fetchImpl: noFetch,
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    ask: async () => ({ answers: { intent_preserved: { type: "noul", noul: 0.95 } } }),
  });
  await commands.improve.handler("fix the workflow", {
    cwd: "/repo",
    modelRegistry: registry,
    sessionManager: { getBranch: () => [] },
    ui: {
      getEditorText: () => editor.text,
      setEditorText: (value) => {
        editor.text = value;
      },
      notify: () => {},
      setStatus: () => {},
    },
  });
  assert.equal(editor.text, "Improved prompt.");
  assert.equal(entries[0].data.model, "openai-codex/gpt-6-luna");
  assert.equal(entries[0].data.subscription, true);
  assert.equal(JSON.stringify(entries).includes("sk-"), false);
});
