import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TIMEOUT_MS,
  RESULT_CAP,
  accumulateUsage,
  emptyUsage,
  extractLastAssistantText,
  formatResult,
  formatUsageLine,
  resolveFinalStatus,
  resolveMaxTurns,
  resolveTimeoutMs,
  tokensFromUsage,
  truncateText,
  turnAction,
} from "../result.mjs";

test("truncateText caps at 50 KB and appends an ellipsis", () => {
  assert.equal(truncateText(""), "");
  assert.equal(truncateText(null), "");
  assert.equal(truncateText("short"), "short");
  const big = "x".repeat(RESULT_CAP + 10);
  const out = truncateText(big);
  assert.equal(out.length, RESULT_CAP + 2);
  assert.ok(out.endsWith("\n…"));
});

test("formatUsageLine and formatResult", () => {
  assert.equal(formatUsageLine({ turns: 8, tokens: 12400, durationMs: 4100 }), "8 turns · 12.4k tok · 4.1s");
  const text = formatResult({
    agent: "scout",
    description: "auth entry points",
    status: "completed",
    turns: 8,
    tokens: 12400,
    durationMs: 4100,
    text: "found it",
  });
  assert.equal(text, "[scout] auth entry points — completed · 8 turns · 12.4k tok · 4.1s\n\nfound it");
  assert.equal(formatResult({ agent: "scout", status: "stopped" }), "[scout] — stopped");
});

test("extractLastAssistantText walks backward and joins text parts", () => {
  assert.equal(extractLastAssistantText(undefined), "");
  assert.equal(
    extractLastAssistantText([
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "text", text: "old" }] },
      { role: "assistant", content: [{ type: "text", text: "new" }, { type: "text", text: "er" }] },
    ]),
    "newer",
  );
  assert.equal(
    extractLastAssistantText([{ role: "assistant", content: "plain" }]),
    "plain",
  );
});

test("resolveMaxTurns only lowers the cap", () => {
  assert.equal(resolveMaxTurns(undefined, undefined), 30);
  assert.equal(resolveMaxTurns(10, undefined), 10);
  assert.equal(resolveMaxTurns(10, 5), 5);
  assert.equal(resolveMaxTurns(10, 20), 10);
  assert.equal(resolveMaxTurns(99, 99), 30);
});

test("turnAction wraps at the cap and aborts after grace", () => {
  assert.equal(turnAction(29, 30), "continue");
  assert.equal(turnAction(30, 30), "wrap");
  assert.equal(turnAction(31, 30), "continue");
  assert.equal(turnAction(32, 30), "abort");
});

test("resolveTimeoutMs: frontmatter may raise/lower, tool only lowers", () => {
  assert.equal(resolveTimeoutMs(undefined, undefined), DEFAULT_TIMEOUT_MS);
  assert.equal(resolveTimeoutMs(60000, undefined), 60000);
  assert.equal(resolveTimeoutMs(undefined, 10000), 10000);
  assert.equal(resolveTimeoutMs(60000, 10000), 10000);
  assert.equal(resolveTimeoutMs(60000, 120000), 60000);
});

test("tokensFromUsage prefers totalTokens and includes cacheRead", () => {
  assert.equal(tokensFromUsage(undefined), 0);
  assert.equal(tokensFromUsage({ totalTokens: 123 }), 123);
  assert.equal(tokensFromUsage({ total: 99 }), 99);
  assert.equal(tokensFromUsage({ input: 10, output: 5, cacheRead: 3, cacheWrite: 2 }), 20);
});

test("accumulateUsage sums fields across messages", () => {
  const acc = emptyUsage();
  assert.deepEqual(acc, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
  accumulateUsage(acc, { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, totalTokens: 20, cost: { total: 0.01 } });
  accumulateUsage(acc, { input: 1, output: 1, totalTokens: 2 });
  assert.equal(acc.input, 11);
  assert.equal(acc.output, 6);
  assert.equal(acc.cacheRead, 3);
  assert.equal(acc.cacheWrite, 2);
  assert.equal(acc.totalTokens, 22);
  assert.equal(acc.cost.total, 0.01);
  accumulateUsage(acc, "junk");
  assert.equal(acc.input, 11);
});

test("resolveFinalStatus marks a wrapped completion as wrapped up", () => {
  assert.equal(resolveFinalStatus({ status: "completed", wrapSent: false, turns: 40, maxTurns: 30 }), "completed");
  assert.equal(resolveFinalStatus({ status: "completed", wrapSent: true, turns: 40, maxTurns: 30 }), "wrapped up");
  assert.equal(resolveFinalStatus({ status: "timed out", wrapSent: false, turns: 5, maxTurns: 30 }), "timed out");
  assert.equal(resolveFinalStatus({ status: "stopped", wrapSent: false, turns: 1, maxTurns: 30 }), "stopped");
});
