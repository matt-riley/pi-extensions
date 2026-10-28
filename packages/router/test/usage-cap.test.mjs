// Usage-cap recognition. Pi flattens provider errors to a string, and a leaked
// WebSocket payload can contain both a usage-limit type and a bare 429. The
// usage rule has to win, or a hard cap is treated as a retryable overload.

import assert from "node:assert/strict";
import test from "node:test";

import { chooseModelForTier } from "../model-battery.mjs";
import {
  classifyProviderError,
  createUsageCaps,
  offersExceptCooling,
  SHORT_USAGE_COOLDOWN_MS,
  usageCapFromMessages,
  usageCooldownMs,
} from "../usage-cap.mjs";

const WS_USAGE_LEAK =
  'Codex error: {"type":"error","status":429,"error":{"type":"usage_limit_reached","message":"The usage limit has been reached"}}';

test("a websocket usage-limit leak that also contains 429 is a usage cap", () => {
  assert.equal(classifyProviderError(WS_USAGE_LEAK), "usage");
});

test("an SSE 429 usage limit with a reset suffix is a usage cap", () => {
  assert.equal(
    classifyProviderError(
      "You have hit your ChatGPT usage limit (plus plan). Try again in ~180 min.",
    ),
    "usage",
  );
});

test("an SSE usage limit with a reset suffix cools down for that many minutes", () => {
  assert.equal(
    usageCooldownMs("You have hit your ChatGPT usage limit (plus plan). Try again in ~180 min."),
    180 * 60 * 1000,
  );
});

test("an SSE usage limit without a reset suffix uses the short default", () => {
  const text = "You have hit your ChatGPT usage limit.";
  assert.equal(classifyProviderError(text), "usage");
  assert.equal(usageCooldownMs(text), SHORT_USAGE_COOLDOWN_MS);
});

test("an overload is not a usage cap", () => {
  assert.equal(
    classifyProviderError("Our servers are currently overloaded. Please try again later."),
    "overload",
  );
});

test("a context overflow is not a usage cap", () => {
  assert.equal(
    classifyProviderError("Your input exceeds the context window of this model."),
    "context-overflow",
  );
});

test("an error that matches neither rule is not a usage cap", () => {
  assert.equal(classifyProviderError("An error occurred while processing your request."), null);
});

test("a websocket usage limit that names the cap in prose is a usage cap", () => {
  assert.equal(classifyProviderError("Codex error: The usage limit has been reached"), "usage");
});

test("quota wordings from the usage rule are caps, not overloads", () => {
  for (const text of ["usage_not_included", "insufficient_quota", "quota exceeded"]) {
    assert.equal(classifyProviderError(text), "usage", text);
  }
});

test("an expired usage cap drops out", () => {
  const caps = createUsageCaps();
  const start = 1_700_000_000_000;
  caps.record("openai-codex/gpt-5.6-luna", 180 * 60 * 1000, start);
  assert.deepEqual(caps.active(start + 60_000), ["openai-codex/gpt-5.6-luna"]);
  assert.deepEqual(caps.active(start + 180 * 60 * 1000), []);
});

test("the last assistant usage-cap error names that model and its wait", () => {
  const found = usageCapFromMessages([
    {
      type: "message",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "You have hit your ChatGPT usage limit (plus plan). Try again in ~15 min.",
        provider: "openai-codex",
        model: "gpt-5.6-luna",
      },
    },
  ]);
  assert.deepEqual(found, { key: "openai-codex/gpt-5.6-luna", ms: 15 * 60 * 1000 });
});

const assistantError = (errorMessage, model = "gpt-5.6-luna", stopReason = "error") => ({
  role: "assistant",
  stopReason,
  errorMessage,
  provider: "openai-codex",
  model,
});

test("an overload, a context overflow, and any other error are not recorded as caps", () => {
  for (const text of [
    "Our servers are currently overloaded. Please try again later.",
    "Your input exceeds the context window of this model.",
    "An error occurred while processing your request.",
  ]) {
    assert.equal(usageCapFromMessages([assistantError(text)]), null, text);
  }
});

test("a later successful assistant message does not keep an earlier usage cap", () => {
  assert.equal(
    usageCapFromMessages([
      assistantError("You have hit your ChatGPT usage limit. Try again in ~30 min."),
      assistantError("done", "gpt-5.6-luna", "stop"),
    ]),
    null,
  );
});

test("an SSE usage limit without a suffix records the short default for that model", () => {
  assert.deepEqual(
    usageCapFromMessages([assistantError("You have hit your ChatGPT usage limit.")]),
    { key: "openai-codex/gpt-5.6-luna", ms: SHORT_USAGE_COOLDOWN_MS },
  );
});

test("a websocket usage-limit leak records a cap for that model", () => {
  assert.deepEqual(usageCapFromMessages([assistantError(WS_USAGE_LEAK, "gpt-6-astra")]), {
    key: "openai-codex/gpt-6-astra",
    ms: SHORT_USAGE_COOLDOWN_MS,
  });
});

test("every cooled pair in a tier leaves chooseModelForTier with nothing", () => {
  const caps = createUsageCaps();
  const start = 1_700_000_000_000;
  const offers = [
    { provider: "openai-codex", id: "gpt-6-astra" },
    { provider: "openai-codex", id: "gpt-5.6-sol" },
  ];
  const tiers = { frontier: ["openai-codex/gpt-6-astra", "openai-codex/gpt-5.6-sol"] };
  caps.record("openai-codex/gpt-6-astra", 60_000, start);
  caps.record("openai-codex/gpt-5.6-sol", 60_000, start);
  assert.equal(
    chooseModelForTier(offersExceptCooling(offers, caps.active(start)), "frontier", tiers),
    null,
  );
});

test("a cooling model is left out of the offers", () => {
  const caps = createUsageCaps();
  const start = 1_700_000_000_000;
  caps.record("openai-codex/gpt-6-astra", SHORT_USAGE_COOLDOWN_MS, start);
  const offers = [
    { provider: "openai-codex", id: "gpt-6-astra" },
    { provider: "openai-codex", id: "gpt-5.6-sol" },
  ];
  assert.deepEqual(
    offersExceptCooling(offers, caps.active(start + 1)).map((model) => model.id),
    ["gpt-5.6-sol"],
  );
});
