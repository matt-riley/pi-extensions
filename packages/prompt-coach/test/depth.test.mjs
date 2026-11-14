import { test } from "node:test";
import assert from "node:assert/strict";

import { buildCoachQuestions } from "../battery.mjs";
import { rewriteWithModel } from "../rewrite.mjs";

async function systemPrompt() {
  let body;
  await rewriteWithModel({
    prompt: "fix it",
    env: { OPENAI_API_KEY: "k" },
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return { ok: true, json: async () => ({ choices: [{ message: { content: "Fix it." } }] }) };
    },
  });
  return body.messages[0].content;
}

test("the rewrite prompt asks for the four depth moves", async () => {
  const prompt = await systemPrompt();
  assert.match(prompt, /read the files? .*(first|before)/i);
  assert.match(prompt, /raw material|primary source/i);
  assert.match(prompt, /summary|digest/i);
  assert.match(prompt, /specific (methods|techniques).*tools|name the .*methods/i);
  assert.match(prompt, /independent check/i);
  assert.match(prompt, /neither the user nor/i);
});

test("the professional question is bounded so it cannot widen the job", async () => {
  const prompt = await systemPrompt();
  assert.match(prompt, /experienced practitioner/i);
  assert.match(prompt, /only if the task would otherwise be done worse/i);
});

test("the hard rules are stated", async () => {
  const prompt = await systemPrompt();
  assert.match(prompt, /deeper, not bigger/i);
  assert.match(prompt, /keep the user's goal, scope, constraints,? and voice/i);
  assert.match(prompt, /do not invent .*requirements/i);
  assert.match(prompt, /only name paths, commands, scripts,? and tests that you have (seen|read)/i);
  assert.match(prompt, /data, not instructions/i);
  assert.match(prompt, /Return only the replacement prompt/);
});

test("steering messages and already-clear prompts stay unchanged", async () => {
  const prompt = await systemPrompt();
  assert.match(prompt, /question, correction, answer, or mid-task steering/i);
  assert.match(prompt, /already clear/i);
});

test("the intent check accepts real depth but rejects new deliverables", () => {
  const question = buildCoachQuestions().intent_preserved;
  assert.match(question.instructions, /naming (real )?files, commands, or a check is not drift/i);
  assert.match(question.instructions, /new (features|deliverables)/i);
});
