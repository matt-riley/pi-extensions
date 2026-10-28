import { test } from "node:test";
import assert from "node:assert/strict";

import { formatShadowReport, summarizeShadowLog } from "../packages/router/shadow-log.mjs";

test("router-shadow-report script math matches the library on example rows", () => {
  const lines = [
    {
      actual: { key: "a", thinking: "medium" },
      wouldBe: { tier: "base", key: "a", thinking: "medium" },
    },
    {
      actual: { key: "a", thinking: "medium" },
      wouldBe: { tier: "mid", key: "b", thinking: "low" },
    },
  ];
  const summary = summarizeShadowLog(lines);
  const text = formatShadowReport(summary);
  assert.match(text, /2 turns/);
  assert.match(text, /base 1 \(50%\)/);
  assert.match(text, /different 1/);
});
