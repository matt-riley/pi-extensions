import { test } from "node:test";
import assert from "node:assert/strict";
import { composeLine, fmtCost, fmtTokens, thinkColor, visibleWidth } from "../format.mjs";

// Fake theme.fg emitting realistic numeric SGR codes (pi emits e.g. 38;5;214m).
const apply = (color, text) => `\u001b[38;5;1m${text}\u001b[0m`;

test("visibleWidth strips ANSI codes", () => {
  assert.equal(visibleWidth("\u001b[31mabc\u001b[0m"), 3);
  assert.equal(visibleWidth("plain"), 5);
});

test("fmtTokens", () => {
  assert.equal(fmtTokens(0), "0");
  assert.equal(fmtTokens(999), "999");
  assert.equal(fmtTokens(1000), "1.0k");
  assert.equal(fmtTokens(12345), "12.3k");
  assert.equal(fmtTokens(2_500_000), "2.5M");
});

test("fmtCost", () => {
  assert.equal(fmtCost(0), "$0.000");
  assert.equal(fmtCost(0.0042), "$0.0042");
  assert.equal(fmtCost(0.012345), "$0.012");
  assert.equal(fmtCost(2), "$2.000");
});

test("thinkColor maps levels and falls back", () => {
  assert.equal(thinkColor("high"), "thinkingHigh");
  assert.equal(thinkColor("off"), "thinkingOff");
  assert.equal(thinkColor("xhigh"), "thinkingXhigh");
  assert.equal(thinkColor("bogus"), "thinkingHigh");
});

test("composeLine fills width with gap between blocks", () => {
  const line = composeLine([{ text: "abc", color: "accent" }], [{ text: "xyz", color: "dim" }], 20, apply);
  assert.equal(visibleWidth(line), 20);
  assert.ok(line.startsWith("\u001b[38;5;1mabc\u001b[0m"));
  assert.ok(line.endsWith("\u001b[38;5;1mxyz\u001b[0m"));
});

test("composeLine drops trailing right segments first", () => {
  const left = [{ text: "m" }];
  const right = [{ text: "aa" }, { text: "bb" }, { text: "cc" }];
  // vis: 1 + 1 + 6 = 8 > 6, so "cc" drops; then 1+1+4 = 6 fits.
  const line = composeLine(left, right, 6, apply);
  assert.equal(visibleWidth(line), 6);
  assert.ok(line.includes("aabb"));
  assert.ok(!line.includes("cc"));
});

test("composeLine truncates model label with ellipsis before dropping it", () => {
  const left = [{ text: "verylongmodelname" }];
  const right = [{ text: "rr" }];
  // vis: 17 + 1 + 2 = 20 > 8; model truncates to 8-2-1-1 = 4 chars + ellipsis.
  const line = composeLine(left, right, 8, apply);
  assert.equal(visibleWidth(line), 8);
  assert.ok(line.includes("very…"));
  assert.ok(!line.includes("verylong"));
});

test("composeLine drops thinking badge before the model", () => {
  const left = [{ text: "model" }, { text: " ~high" }];
  const right = [{ text: "rr" }];
  // vis: 5+6+1+2 = 14 > 10 → badge drops → 5+1+2 = 8 fits, model survives.
  const line = composeLine(left, right, 10, apply);
  assert.equal(visibleWidth(line), 10);
  assert.ok(line.includes("model"));
  assert.ok(!line.includes("high"));
});

test("composeLine leaves right side when the model must go", () => {
  const left = [{ text: "m" }];
  const right = [{ text: "rr" }];
  const line = composeLine(left, right, 2, apply);
  assert.equal(visibleWidth(line), 2);
  assert.ok(line.includes("rr"));
  assert.ok(!line.includes("m"));
});
