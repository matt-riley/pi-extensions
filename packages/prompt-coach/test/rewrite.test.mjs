import { test } from "node:test";
import assert from "node:assert/strict";

import { rewriteWithLocalModel } from "../rewrite.mjs";

test("rewriteWithLocalModel calls the local OpenAI-compatible endpoint", async () => {
  let request;
  const result = await rewriteWithLocalModel({
    prompt: "fix the failing workflow on main",
    probe: { branch: "main" },
    cwd: "/repo",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        json: async () => ({
          choices: [
            { message: { content: "Fix the failing workflow on main and run npm run check." } },
          ],
        }),
      };
    },
  });

  assert.equal(result, "Fix the failing workflow on main and run npm run check.");
  assert.equal(request.url, "http://127.0.0.1:12434/v1/chat/completions");
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, "docker.io/ai/gemma4:latest");
  assert.deepEqual(body.chat_template_kwargs, { enable_thinking: false });
  assert.equal(body.messages[0].role, "system");
  assert.match(body.messages[0].content, /Return only the replacement prompt/);
  assert.match(body.messages[1].content, /failing workflow/);
});

test("rewriteWithLocalModel strips an outer markdown fence", async () => {
  const result = await rewriteWithLocalModel({
    prompt: "fix it",
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "```text\nFix it.\n```" } }] }),
    }),
  });
  assert.equal(result, "Fix it.");
});

test("rewriteWithLocalModel reports local endpoint failures", async () => {
  await assert.rejects(
    rewriteWithLocalModel({
      prompt: "fix it",
      fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
    }),
    /status 503/,
  );
});
