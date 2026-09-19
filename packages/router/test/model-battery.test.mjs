import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildDifficultyState,
  buildQuestions,
  chooseModelForTier,
  DEFAULT_MID_PATTERNS,
  DEFAULT_TIERS,
  DEFAULT_TIER_THINKING,
  DIFFICULTY_THRESHOLD,
  FRONTIER_THRESHOLD,
  latestContextTokens,
  modelKey,
  routeFromDifficulty,
  THINKING_LEVELS,
  thinkingForTier,
  thinkingRank,
  tierOf,
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

test("routeFromDifficulty splits escalation into mid and frontier tiers", () => {
  const mid = routeFromDifficulty({ difficulty: score(DIFFICULTY_THRESHOLD) });
  assert.equal(mid.escalate, true);
  assert.equal(mid.tier, "mid");
  assert.match(mid.reason, /1\.50/);
  assert.match(mid.reason, /mid/);

  const frontier = routeFromDifficulty({ difficulty: score(FRONTIER_THRESHOLD) });
  assert.equal(frontier.escalate, true);
  assert.equal(frontier.tier, "frontier");
  assert.match(frontier.reason, /2\.50/);
  assert.match(frontier.reason, /frontier/);

  const held = routeFromDifficulty({ difficulty: score(0.6) });
  assert.equal(held.escalate, false);
  assert.equal(held.tier, null);

  const unusable = routeFromDifficulty({ difficulty: score(null) });
  assert.equal(unusable.escalate, null);
  assert.equal(unusable.tier, null);

  // The frontier line is a dial, not a constant, and defaults to 2.5.
  assert.equal(FRONTIER_THRESHOLD, 2.5);
  assert.equal(
    routeFromDifficulty({ difficulty: score(2) }, { frontierThreshold: 1.9 }).tier,
    "frontier",
  );
});

test("a frontier line below the escalate line cannot make mid unreachable", () => {
  const thresholds = { threshold: 2.0, frontierThreshold: 1.0 };
  assert.equal(routeFromDifficulty({ difficulty: score(1.5) }, thresholds).tier, "mid");
  assert.equal(routeFromDifficulty({ difficulty: score(2.5) }, thresholds).tier, "frontier");
});

test("a rating outside the scale, or of the wrong type, is no decision", () => {
  // Number(true) is 1 and Number([2]) is 2; neither may authorise a switch.
  for (const raw of [true, false, [2], { value: 2 }, 5, -1, NaN, Infinity, null, "2"]) {
    assert.equal(
      routeFromDifficulty({ difficulty: { type: "score", score: raw } }).escalate,
      null,
      String(raw),
    );
  }
  assert.equal(
    routeFromDifficulty({ difficulty: score(3) }).escalate,
    true,
    "the top of the scale is usable",
  );
  assert.equal(routeFromDifficulty({ difficulty: score(0) }).escalate, false);
});

test("buildDifficultyState refuses a caller that passes the wrong shape", () => {
  // It was called positionally once and silently judged an empty prompt.
  assert.throws(() => buildDifficultyState("a prompt"), /expects \{ prompt, window, cwd \}/);
  assert.deepEqual(buildDifficultyState().conversation, []);
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

test("chooseModelForTier follows the preference order and reports what matched", () => {
  const available = [
    { provider: "openai-codex", id: "gpt-5.6-luna" },
    { provider: "openai-codex", id: "gpt-5.6-sol" },
    { provider: "openai-codex", id: "gpt-6-astra" },
  ];
  const chosen = chooseModelForTier(available, "frontier");
  assert.equal(chosen.key, "openai-codex/gpt-6-astra");
  assert.equal(chosen.model.id, "gpt-6-astra");
  assert.equal(chosen.tier, "frontier");

  const narrowed = chooseModelForTier(available, "frontier", { frontier: ["gpt-5.6-sol"] });
  assert.equal(narrowed.key, "openai-codex/gpt-5.6-sol");
});

test("a mid-tier selection comes from the mid list, not the frontier one", () => {
  const available = [
    { provider: "openai-codex", id: "gpt-6-astra" },
    { provider: "openai-codex", id: "gpt-5.6-luna" },
  ];
  const chosen = chooseModelForTier(available, "mid");
  assert.equal(chosen.key, "openai-codex/gpt-5.6-luna");
  assert.equal(chosen.pattern, "openai-codex/gpt-5.6-luna");
  assert.equal(chosen.tier, "mid");
});

test("DEFAULT_MID_PATTERNS is the curated mid preference order", () => {
  assert.deepEqual(DEFAULT_MID_PATTERNS, ["openai-codex/gpt-5.6-luna"]);
  assert.equal(DEFAULT_TIERS.mid, DEFAULT_MID_PATTERNS);
});

test("tierOf classifies a key, frontier first, and unknown keys are null", () => {
  assert.equal(tierOf("openai-codex/gpt-6-astra"), "frontier");
  assert.equal(tierOf("openai-codex/gpt-5.6-luna"), "mid");
  assert.equal(tierOf("deepseek/deepseek-flash"), null);
  assert.equal(tierOf(null), null);
  // Frontier is checked first, so a key in both lists is frontier.
  assert.equal(tierOf("x/y", { frontier: ["y"], mid: ["y"] }), "frontier");
});

test("a GPT model comes from openai-codex even when another provider lists it first", () => {
  // The live failure this rule exists for: the catalogue offered Copilot's
  // astra before Codex's and the router took the first match.
  const available = [
    { provider: "github-copilot", id: "gpt-6-astra" },
    { provider: "openai-codex", id: "gpt-6-astra" },
    { provider: "github-copilot", id: "gpt-5.6-sol" },
  ];
  const chosen = chooseModelForTier(available, "frontier", { frontier: ["gpt-6-astra"] });
  assert.equal(chosen.key, "openai-codex/gpt-6-astra");
});

test("the preference also applies to unqualified patterns from the environment", () => {
  const available = [
    { provider: "github-copilot", id: "gpt-5.6-sol" },
    { provider: "openrouter", id: "openai/gpt-5.6-sol" },
    { provider: "openai-codex", id: "gpt-5.6-sol" },
  ];
  assert.equal(
    chooseModelForTier(available, "frontier", { frontier: ["gpt-5.6-sol"] }).key,
    "openai-codex/gpt-5.6-sol",
  );
});

test("a pinned provider is not overridden, and a missing one falls through", () => {
  const available = [
    { provider: "github-copilot", id: "gpt-6-astra" },
    { provider: "openai-codex", id: "grok-4.6" },
  ];
  // Pinned to Codex: Copilot's astra does not qualify, so the next pattern wins.
  const pinned = chooseModelForTier(available, "frontier");
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
  assert.equal(chooseModelForTier(available, "frontier", { frontier: ["gpt-6-astra"] }), null);
  // An explicit provider is a deliberate instruction and is honoured.
  assert.equal(
    chooseModelForTier(available, "frontier", { frontier: ["github-copilot/gpt-6-astra"] }).key,
    "github-copilot/gpt-6-astra",
  );
});

test("non-GPT patterns are never restricted to a preferred provider", () => {
  const available = [{ provider: "github-copilot", id: "grok-4.6" }];
  assert.equal(
    chooseModelForTier(available, "frontier", { frontier: ["grok-4.6"] }).key,
    "github-copilot/grok-4.6",
  );
});

test("chooseModelForTier reads the {model} wrapper scopedModels uses", () => {
  const chosen = chooseModelForTier(
    [{ model: { provider: "github-copilot", id: "grok-4.6" }, thinkingLevel: "high" }],
    "frontier",
  );
  assert.equal(chosen.key, "github-copilot/grok-4.6");
  assert.equal(modelKey({ model: { provider: "a", id: "b" } }), "a/b");
  assert.equal(modelKey(null), null);
});

test("no available frontier model is a null, not a guess", () => {
  assert.equal(chooseModelForTier([{ provider: "x", id: "small" }], "frontier"), null);
  assert.equal(chooseModelForTier([], "frontier"), null);
  assert.equal(chooseModelForTier(undefined, "frontier"), null);
  // A tier with no list is a null too, rather than a throw.
  assert.equal(chooseModelForTier([{ provider: "x", id: "small" }], "economy"), null);
});

// ---------------------------------------------------------------------------
// Thinking levels for the (model, thinking) pair

test("THINKING_LEVELS is Pi's seven-level set, weakest first, with no ultra", () => {
  assert.deepEqual(THINKING_LEVELS, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  assert.equal(thinkingRank("off"), 0);
  assert.equal(thinkingRank("medium"), 3);
  assert.equal(thinkingRank("xhigh"), 5);
  assert.equal(thinkingRank("max"), 6);
  assert.equal(thinkingRank("ultra"), -1);
  assert.equal(thinkingRank(undefined), -1);
});

test("thinkingForTier returns curated defaults and null for an unknown tier", () => {
  assert.deepEqual(DEFAULT_TIER_THINKING, { mid: "xhigh", frontier: "medium" });
  assert.equal(thinkingForTier("mid"), "xhigh");
  assert.equal(thinkingForTier("frontier"), "medium");
  assert.equal(thinkingForTier("mid"), DEFAULT_TIER_THINKING.mid);
  assert.equal(thinkingForTier("frontier"), DEFAULT_TIER_THINKING.frontier);
  assert.equal(thinkingForTier("economy"), null);
  assert.equal(thinkingForTier(null), null);
  assert.equal(thinkingForTier("mid", { mid: "high", frontier: "low" }), "high");
});
