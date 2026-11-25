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
  successfulTurnKey,
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
  assert.deepEqual(found, {
    key: "openai-codex/gpt-5.6-luna",
    ms: 15 * 60 * 1000,
    text: "You have hit your ChatGPT usage limit (plus plan). Try again in ~15 min.",
  });
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
    {
      key: "openai-codex/gpt-5.6-luna",
      ms: SHORT_USAGE_COOLDOWN_MS,
      text: "You have hit your ChatGPT usage limit.",
    },
  );
});

test("a websocket usage-limit leak records a cap for that model", () => {
  assert.deepEqual(usageCapFromMessages([assistantError(WS_USAGE_LEAK, "gpt-6-astra")]), {
    key: "openai-codex/gpt-6-astra",
    ms: SHORT_USAGE_COOLDOWN_MS,
    text: WS_USAGE_LEAK,
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

const NO_SUFFIX = "You have hit your ChatGPT usage limit.";
const LUNA_KEY = "openai-codex/gpt-5.6-luna";

test("a first no-suffix recordCap waits the short default", () => {
  const caps = createUsageCaps();
  const start = 1_700_000_000_000;
  assert.equal(caps.recordCap(LUNA_KEY, NO_SUFFIX, start), SHORT_USAGE_COOLDOWN_MS);
  assert.deepEqual(caps.active(start + SHORT_USAGE_COOLDOWN_MS - 1), [LUNA_KEY]);
  assert.deepEqual(caps.active(start + SHORT_USAGE_COOLDOWN_MS), []);
});

test("a repeat no-suffix cap after the window expires steps up the ladder", () => {
  const caps = createUsageCaps();
  const start = 1_700_000_000_000;
  caps.recordCap(LUNA_KEY, NO_SUFFIX, start);
  const second = start + SHORT_USAGE_COOLDOWN_MS;
  assert.equal(caps.recordCap(LUNA_KEY, NO_SUFFIX, second), 15 * 60 * 1000);
  assert.deepEqual(caps.active(second + 15 * 60 * 1000 - 1), [LUNA_KEY]);
  assert.deepEqual(caps.active(second + 15 * 60 * 1000), []);
  const third = second + 15 * 60 * 1000;
  assert.equal(caps.recordCap(LUNA_KEY, NO_SUFFIX, third), 60 * 60 * 1000);
  const fourth = third + 60 * 60 * 1000;
  assert.equal(caps.recordCap(LUNA_KEY, NO_SUFFIX, fourth), 4 * 60 * 60 * 1000);
  const fifth = fourth + 4 * 60 * 60 * 1000;
  assert.equal(caps.recordCap(LUNA_KEY, NO_SUFFIX, fifth), 4 * 60 * 60 * 1000);
  assert.deepEqual(caps.active(fifth + 4 * 60 * 60 * 1000 - 1), [LUNA_KEY]);
  assert.deepEqual(caps.active(fifth + 4 * 60 * 60 * 1000), []);
});

test("recordCap calls for one incident do not bump the streak", () => {
  const caps = createUsageCaps();
  const start = 1_700_000_000_000;
  caps.recordCap(LUNA_KEY, NO_SUFFIX, start);
  caps.recordCap(LUNA_KEY, NO_SUFFIX, start + 1_000);
  caps.recordCap(LUNA_KEY, NO_SUFFIX, start + 5_000);
  assert.deepEqual(caps.active(start + SHORT_USAGE_COOLDOWN_MS - 1), [LUNA_KEY]);
  assert.deepEqual(caps.active(start + SHORT_USAGE_COOLDOWN_MS), []);
});

test("a provider-stated wait wins and does not escalate after a no-suffix cap", () => {
  const caps = createUsageCaps();
  const start = 1_700_000_000_000;
  caps.recordCap(LUNA_KEY, NO_SUFFIX, start);
  const later = start + SHORT_USAGE_COOLDOWN_MS;
  assert.equal(
    caps.recordCap(LUNA_KEY, "You have hit your ChatGPT usage limit. Try again in ~3 min.", later),
    3 * 60 * 1000,
  );
  assert.deepEqual(caps.active(later + 3 * 60 * 1000 - 1), [LUNA_KEY]);
  assert.deepEqual(caps.active(later + 3 * 60 * 1000), []);
});

test("a provider-stated wait does not consume a ladder step", () => {
  const caps = createUsageCaps();
  const start = 1_700_000_000_000;
  caps.recordCap(LUNA_KEY, NO_SUFFIX, start);
  const statedAt = start + SHORT_USAGE_COOLDOWN_MS;
  caps.recordCap(LUNA_KEY, "You have hit your ChatGPT usage limit. Try again in ~3 min.", statedAt);
  const again = statedAt + 3 * 60 * 1000;
  assert.equal(caps.recordCap(LUNA_KEY, NO_SUFFIX, again), 15 * 60 * 1000);
});

test("a provider-stated wait is not shortened by a same-incident no-suffix recordCap", () => {
  const caps = createUsageCaps();
  const start = 1_700_000_000_000;
  caps.recordCap(
    LUNA_KEY,
    "You have hit your ChatGPT usage limit (plus plan). Try again in ~180 min.",
    start,
  );
  caps.recordCap(LUNA_KEY, NO_SUFFIX, start + 1_000);
  assert.deepEqual(caps.active(start + 180 * 60 * 1000 - 1), [LUNA_KEY]);
  assert.deepEqual(caps.active(start + 180 * 60 * 1000), []);
});

test("a first no-suffix cap after a stated wait still uses the short default", () => {
  const caps = createUsageCaps();
  const start = 1_700_000_000_000;
  caps.recordCap(
    LUNA_KEY,
    "You have hit your ChatGPT usage limit (plus plan). Try again in ~15 min.",
    start,
  );
  const later = start + 15 * 60 * 1000;
  assert.equal(caps.recordCap(LUNA_KEY, NO_SUFFIX, later), SHORT_USAGE_COOLDOWN_MS);
});

test("a successful clear on that model resets the no-suffix ladder", () => {
  const caps = createUsageCaps();
  const start = 1_700_000_000_000;
  caps.recordCap(LUNA_KEY, NO_SUFFIX, start);
  const expired = start + SHORT_USAGE_COOLDOWN_MS;
  caps.clear(LUNA_KEY);
  assert.equal(caps.recordCap(LUNA_KEY, NO_SUFFIX, expired), SHORT_USAGE_COOLDOWN_MS);
});

test("clearing a different model leaves this model's streak in place", () => {
  const caps = createUsageCaps();
  const start = 1_700_000_000_000;
  caps.recordCap(LUNA_KEY, NO_SUFFIX, start);
  caps.clear("openai-codex/gpt-6-astra");
  const later = start + SHORT_USAGE_COOLDOWN_MS;
  assert.equal(caps.recordCap(LUNA_KEY, NO_SUFFIX, later), 15 * 60 * 1000);
});

test("successfulTurnKey names the last successful assistant model", () => {
  assert.equal(
    successfulTurnKey([assistantError("done", "gpt-5.6-luna", "stop")]),
    "openai-codex/gpt-5.6-luna",
  );
});

test("successfulTurnKey is null for a usage-cap or any other error", () => {
  assert.equal(successfulTurnKey([assistantError(NO_SUFFIX)]), null);
  assert.equal(
    successfulTurnKey([
      assistantError("Our servers are currently overloaded. Please try again later."),
    ]),
    null,
  );
});

test("successfulTurnKey is null when the last turn was aborted", () => {
  assert.equal(successfulTurnKey([assistantError("", "gpt-5.6-luna", "aborted")]), null);
});

test("successfulTurnKey is null when an error is recorded without stopReason error", () => {
  assert.equal(
    successfulTurnKey([
      {
        role: "assistant",
        stopReason: "aborted",
        errorMessage: "Request aborted",
        provider: "openai-codex",
        model: "gpt-5.6-luna",
      },
    ]),
    null,
  );
});

test("successfulTurnKey treats a toolUse turn as a success", () => {
  assert.equal(
    successfulTurnKey([assistantError("", "gpt-5.6-luna", "toolUse")]),
    "openai-codex/gpt-5.6-luna",
  );
});

test("successfulTurnKey treats a length turn as a success", () => {
  assert.equal(
    successfulTurnKey([assistantError("", "gpt-5.6-luna", "length")]),
    "openai-codex/gpt-5.6-luna",
  );
});
