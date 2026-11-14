import { test } from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { READ_TOOLS } from "../readtools.mjs";
import { resolveProvider, rewriteWithModel } from "../rewrite.mjs";

const reply = (content) => async () => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content } }] }),
});

function capture(content = "Fix the failing workflow on main and run npm run check.") {
  const seen = {};
  const fetchImpl = async (url, options) => {
    seen.url = url;
    seen.options = options;
    return reply(content)();
  };
  return { seen, fetchImpl };
}

test("resolveProvider prefers OpenAI Luna when its key is set", () => {
  const provider = resolveProvider({ OPENAI_API_KEY: "o", DEEPSEEK_API_KEY: "d" });
  assert.equal(provider.name, "openai");
  assert.equal(provider.model, "gpt-6-luna");
  assert.equal(provider.baseUrl, "https://api.openai.com/v1");
  assert.equal(provider.apiKey, "o");
});

test("resolveProvider falls back to DeepSeek Flash when only its key is set", () => {
  const provider = resolveProvider({ DEEPSEEK_API_KEY: "d" });
  assert.equal(provider.name, "deepseek");
  assert.equal(provider.model, "deepseek-flash");
  assert.equal(provider.baseUrl, "https://api.deepseek.com");
});

test("resolveProvider honours an explicit provider and model", () => {
  const provider = resolveProvider({
    PI_PROMPT_COACH_PROVIDER: "deepseek",
    PI_PROMPT_COACH_MODEL: "deepseek-v4-pro",
    OPENAI_API_KEY: "o",
    DEEPSEEK_API_KEY: "d",
  });
  assert.equal(provider.name, "deepseek");
  assert.equal(provider.model, "deepseek-v4-pro");
  assert.equal(provider.apiKey, "d");
});

test("resolveProvider names the variables to set when no key exists", () => {
  assert.throws(() => resolveProvider({}), /OPENAI_API_KEY.*DEEPSEEK_API_KEY/);
  assert.throws(
    () => resolveProvider({ PI_PROMPT_COACH_PROVIDER: "deepseek", OPENAI_API_KEY: "o" }),
    /DEEPSEEK_API_KEY/,
  );
  assert.throws(() => resolveProvider({ PI_PROMPT_COACH_PROVIDER: "gemma" }), /unknown provider/);
});

test("rewriteWithModel calls OpenAI with the key from the environment", async () => {
  const { seen, fetchImpl } = capture();
  const result = await rewriteWithModel({
    prompt: "fix the failing workflow on main",
    probe: { branch: "main" },
    cwd: "/repo",
    env: { OPENAI_API_KEY: "sk-test" },
    fetchImpl,
  });

  assert.equal(result.text, "Fix the failing workflow on main and run npm run check.");
  assert.equal(seen.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(seen.options.headers.authorization, "Bearer sk-test");
  const body = JSON.parse(seen.options.body);
  assert.equal(body.model, "gpt-6-luna");
  assert.equal(body.reasoning_effort, "none");
  assert.equal(body.max_completion_tokens, 4_000);
  assert.equal("max_tokens" in body, false);
  assert.equal(body.messages[0].role, "system");
  assert.match(body.messages[0].content, /Return only the replacement prompt/);
  assert.match(body.messages[1].content, /failing workflow/);
});

test("rewriteWithModel calls DeepSeek with thinking switched off", async () => {
  const { seen, fetchImpl } = capture();
  await rewriteWithModel({
    prompt: "fix it",
    env: { DEEPSEEK_API_KEY: "ds-test" },
    fetchImpl,
  });
  assert.equal(seen.url, "https://api.deepseek.com/chat/completions");
  assert.equal(seen.options.headers.authorization, "Bearer ds-test");
  const body = JSON.parse(seen.options.body);
  assert.equal(body.model, "deepseek-flash");
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.max_tokens, 4_000);
});

test("rewriteWithModel fails before any request when no key is set", async () => {
  let calls = 0;
  await assert.rejects(
    rewriteWithModel({
      prompt: "fix it",
      env: {},
      fetchImpl: async () => {
        calls += 1;
      },
    }),
    /Set OPENAI_API_KEY or DEEPSEEK_API_KEY/,
  );
  assert.equal(calls, 0);
});

test("rewriteWithModel strips an outer markdown fence", async () => {
  const result = await rewriteWithModel({
    prompt: "fix it",
    env: { OPENAI_API_KEY: "k" },
    fetchImpl: reply("```text\nFix it.\n```"),
  });
  assert.equal(result.text, "Fix it.");
});

test("rewriteWithModel reports HTTP failures without leaking the key", async () => {
  await assert.rejects(
    rewriteWithModel({
      prompt: "fix it",
      env: { OPENAI_API_KEY: "sk-secret" },
      fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }),
    }),
    (error) => /openai.*status 401/.test(error.message) && !error.message.includes("sk-secret"),
  );
});

function scriptedModel(steps) {
  const requests = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    const step = steps[Math.min(requests.length - 1, steps.length - 1)];
    const message = typeof step === "function" ? step(body) : step;
    return { ok: true, json: async () => ({ choices: [{ message }] }) };
  };
  return { requests, fetchImpl };
}

const toolCall = (id, name, args) => ({
  content: null,
  tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
});

function tmpRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coach-rw-"));
  fs.writeFileSync(path.join(root, "loader.mjs"), "export const retries = 1;\n");
  return root;
}

const env = { OPENAI_API_KEY: "k" };

test("the request offers the read-only tools and no others", async () => {
  const { requests, fetchImpl } = scriptedModel([{ content: "Done." }]);
  await rewriteWithModel({ prompt: "fix it", cwd: tmpRepo(), env, fetchImpl });
  assert.deepEqual(requests[0].tools, READ_TOOLS);
  const names = requests[0].tools.map((tool) => tool.function.name);
  assert.deepEqual(names.sort(), ["list_dir", "read_file", "search_text"]);
});

test("a file the model reads is fed back and reported", async () => {
  const { requests, fetchImpl } = scriptedModel([
    toolCall("c1", "read_file", { path: "loader.mjs" }),
    { content: "Make retries in loader.mjs 2." },
  ]);
  const result = await rewriteWithModel({ prompt: "retry twice", cwd: tmpRepo(), env, fetchImpl });
  assert.equal(result.text, "Make retries in loader.mjs 2.");
  assert.deepEqual(result.filesRead, ["loader.mjs"]);
  const toolMessage = requests[1].messages.find((message) => message.role === "tool");
  assert.equal(toolMessage.tool_call_id, "c1");
  assert.match(toolMessage.content, /retries = 1/);
});

test("a bash or write request is refused and changes nothing", async () => {
  const root = tmpRepo();
  const { requests, fetchImpl } = scriptedModel([
    toolCall("c1", "bash", { command: "touch pwned" }),
    toolCall("c2", "write_file", { path: "pwned", content: "x" }),
    { content: "Fix it." },
  ]);
  const result = await rewriteWithModel({ prompt: "fix it", cwd: root, env, fetchImpl });
  assert.equal(result.text, "Fix it.");
  assert.equal(fs.existsSync(path.join(root, "pwned")), false);
  const refusals = requests[2].messages.filter((message) => message.role === "tool");
  assert.equal(refusals.length, 2);
  for (const message of refusals) assert.match(message.content, /not available/);
});

test("tool rounds are capped and the last request carries no tools", async () => {
  const { requests, fetchImpl } = scriptedModel([
    (body) => (body.tools ? toolCall("c", "list_dir", { path: "." }) : { content: "Final." }),
  ]);
  const result = await rewriteWithModel({ prompt: "fix it", cwd: tmpRepo(), env, fetchImpl });
  assert.equal(result.text, "Final.");
  assert.equal(requests.length, 7);
  assert.equal("tools" in requests[6], false);
});

test("PI_PROMPT_COACH_READ_FILES=0 sends no tools at all", async () => {
  const { requests, fetchImpl } = scriptedModel([{ content: "Done." }]);
  await rewriteWithModel({
    prompt: "fix it",
    cwd: tmpRepo(),
    env: { ...env, PI_PROMPT_COACH_READ_FILES: "0" },
    fetchImpl,
  });
  assert.equal("tools" in requests[0], false);
});
