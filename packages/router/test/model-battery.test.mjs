import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildDifficultyState,
  buildQuestions,
  chooseFrontierModel,
  DIFFICULTY_THRESHOLD,
  latestContextTokens,
  modelKey,
  routeFromDifficulty,
  turnsFromBranch,
  WINDOW,
} from "../model-battery.mjs";

const score = (value) => ({ type: "score", score: value });

// ---------------------------------------------------------------------------
// Reading a session branch

test("turnsFromBranch groups messages into turns with their failures", () => {
  const branch = [
    {
      type: "message",
      message: { role: "user", content: [{ type: "text", text: "fix the parser" }] },
    },
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "Looking at it." }] },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", name: "read" },
          { type: "toolCall", name: "bash" },
        ],
      },
    },
    { type: "message", message: { role: "toolResult", toolName: "bash", isError: true } },
    { type: "message", message: { role: "user", content: "push" } },
  ];
  const turns = turnsFromBranch(branch);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].prompt, "fix the parser");
  assert.equal(turns[0].lastResponse, "Looking at it.");
  assert.deepEqual(
    turns[0].toolCalls.map((call) => call.name),
    ["read", "bash", "bash"],
  );
  assert.equal(turns[0].toolCalls.filter((call) => call.isError).length, 1);
  assert.equal(turns[1].prompt, "push");
});

test("turnsFromBranch tolerates bare messages and keeps only the window", () => {
  const branch = [];
  for (let i = 0; i < 8; i++) branch.push({ role: "user", content: `turn ${i}` });
  const turns = turnsFromBranch(branch);
  assert.equal(turns.length, WINDOW);
  assert.equal(turns.at(-1).prompt, "turn 7");
  assert.deepEqual(turnsFromBranch(undefined), []);
  assert.deepEqual(turnsFromBranch([{ role: "assistant", content: "no prompt yet" }]), []);
});

test("turnsFromBranch ignores user records with no text", () => {
  const turns = turnsFromBranch([
    { role: "user", content: [{ type: "image" }] },
    { role: "user", content: "real prompt" },
  ]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].prompt, "real prompt");
});

test("turnsFromBranch records the context the session last read", () => {
  const turns = turnsFromBranch([
    { role: "user", content: "first" },
    { role: "assistant", content: "ok", usage: { input: 1000, cacheRead: 180000 } },
    { role: "user", content: "second" },
    { role: "assistant", content: "ok", usage: { input: 5, cacheRead: 0 } },
  ]);
  assert.equal(turns[0].contextTokens, 181000);
  assert.equal(turns[1].contextTokens, 5);
  assert.equal(latestContextTokens(turns), 5);
  assert.equal(latestContextTokens([]), 0);
  assert.equal(latestContextTokens(undefined), 0);
});

// ---------------------------------------------------------------------------
// The measured state

test("buildDifficultyState produces the shape that was measured", () => {
  const state = buildDifficultyState({
    prompt: "Stick to the task yo",
    cwd: "/repo",
    window: [
      {
        prompt: "Right, one last chance",
        lastResponse: "I built four prototypes.",
        toolCalls: [
          { name: "edit", isError: false },
          { name: "bash", isError: true },
        ],
      },
    ],
  });
  assert.deepEqual(state, {
    prompt: "Stick to the task yo",
    working_directory: "/repo",
    conversation: [
      {
        prompt: "Right, one last chance",
        assistant_response: "I built four prototypes.",
        failures: 1,
        tools_used: ["edit", "bash"],
      },
    ],
  });
});

test("buildDifficultyState truncates without dropping the conversation", () => {
  const state = buildDifficultyState({
    prompt: "x".repeat(5000),
    window: [{ prompt: "y".repeat(1000), lastResponse: "z".repeat(1000) }],
  });
  assert.equal(state.prompt.length, 2000);
  assert.equal(state.conversation[0].prompt.length, 400);
  assert.equal(state.conversation[0].assistant_response.length, 400);
});

// ---------------------------------------------------------------------------
// The decision

test("routeFromDifficulty escalates at the measured threshold", () => {
  assert.equal(routeFromDifficulty({ difficulty: score(DIFFICULTY_THRESHOLD) }).escalate, true);
  assert.equal(
    routeFromDifficulty({ difficulty: score(DIFFICULTY_THRESHOLD - 0.01) }).escalate,
    false,
  );
  assert.equal(routeFromDifficulty({ difficulty: score(2.18) }).escalate, true);
  assert.match(routeFromDifficulty({ difficulty: score(2.18) }).reason, /2\.18/);
});

test("an absent rating is not a decision to downgrade", () => {
  // null means "keep what you have" — never "use the cheap model".
  for (const answers of [
    {},
    { difficulty: { type: "score" } },
    { difficulty: score(null) },
    undefined,
  ]) {
    assert.equal(routeFromDifficulty(answers).escalate, null, JSON.stringify(answers));
  }
});

test("the question set keeps both instruments, the router using the score", () => {
  const questions = buildQuestions();
  assert.deepEqual(Object.keys(questions).sort(), ["difficulty", "needs_frontier"]);
  assert.equal(questions.difficulty.type, "score");
  assert.equal(questions.difficulty.criteria.length, 4);
  assert.equal(questions.needs_frontier.type, "noul");
});

// ---------------------------------------------------------------------------
// Choosing which model

test("chooseFrontierModel follows the preference order and reports what matched", () => {
  const available = [
    { provider: "openai-codex", id: "gpt-5.6-luna" },
    { provider: "openai-codex", id: "gpt-5.6-sol" },
    { provider: "openai-codex", id: "gpt-6-astra" },
  ];
  const chosen = chooseFrontierModel(available);
  assert.equal(chosen.key, "openai-codex/gpt-6-astra");
  assert.equal(chosen.model.id, "gpt-6-astra");

  const narrowed = chooseFrontierModel(available, ["gpt-5.6-sol"]);
  assert.equal(narrowed.key, "openai-codex/gpt-5.6-sol");
});

test("a GPT model comes from openai-codex even when another provider lists it first", () => {
  // The live failure this rule exists for: the catalogue offered Copilot's
  // astra before Codex's and the router took the first match.
  const available = [
    { provider: "github-copilot", id: "gpt-6-astra" },
    { provider: "openai-codex", id: "gpt-6-astra" },
    { provider: "github-copilot", id: "gpt-5.6-sol" },
  ];
  const chosen = chooseFrontierModel(available, ["gpt-6-astra"]);
  assert.equal(chosen.key, "openai-codex/gpt-6-astra");
});

test("the preference also applies to unqualified patterns from the environment", () => {
  const available = [
    { provider: "github-copilot", id: "gpt-5.6-sol" },
    { provider: "openrouter", id: "openai/gpt-5.6-sol" },
    { provider: "openai-codex", id: "gpt-5.6-sol" },
  ];
  assert.equal(chooseFrontierModel(available, ["gpt-5.6-sol"]).key, "openai-codex/gpt-5.6-sol");
});

test("a pinned provider is not overridden, and a missing one falls through", () => {
  const available = [
    { provider: "github-copilot", id: "gpt-6-astra" },
    { provider: "openai-codex", id: "grok-4.6" },
  ];
  // Pinned to Codex: Copilot's astra does not qualify, so the next pattern wins.
  const pinned = chooseFrontierModel(available);
  assert.equal(pinned.key, "openai-codex/grok-4.6");
  assert.equal(pinned.pattern, "grok-4.6");
});

test("a GPT pattern never resolves to another provider's copy of the model", () => {
  const available = [
    { provider: "github-copilot", id: "gpt-6-astra" },
    { provider: "openrouter", id: "openai/gpt-6-astra" },
  ];
  // Codex has it nowhere in this catalogue, so the pattern is skipped rather
  // than billed to a reseller.
  assert.equal(chooseFrontierModel(available, ["gpt-6-astra"]), null);
  // An explicit provider is a deliberate instruction and is honoured.
  assert.equal(
    chooseFrontierModel(available, ["github-copilot/gpt-6-astra"]).key,
    "github-copilot/gpt-6-astra",
  );
});

test("non-GPT patterns are never restricted to a preferred provider", () => {
  const available = [{ provider: "github-copilot", id: "grok-4.6" }];
  assert.equal(chooseFrontierModel(available, ["grok-4.6"]).key, "github-copilot/grok-4.6");
});

test("chooseFrontierModel reads the {model} wrapper scopedModels uses", () => {
  const chosen = chooseFrontierModel([
    { model: { provider: "github-copilot", id: "grok-4.6" }, thinkingLevel: "high" },
  ]);
  assert.equal(chosen.key, "github-copilot/grok-4.6");
  assert.equal(modelKey({ model: { provider: "a", id: "b" } }), "a/b");
  assert.equal(modelKey(null), null);
});

test("no available frontier model is a null, not a guess", () => {
  assert.equal(chooseFrontierModel([{ provider: "x", id: "small" }]), null);
  assert.equal(chooseFrontierModel([]), null);
  assert.equal(chooseFrontierModel(undefined), null);
});
