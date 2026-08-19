import { test } from "node:test";
import assert from "node:assert/strict";
import {
  RESULT_CAP,
  extractLastAssistantText,
  formatResult,
  formatUsageLine,
  resolveMaxTurns,
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
