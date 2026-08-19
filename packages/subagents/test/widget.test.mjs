import { test } from "node:test";
import assert from "node:assert/strict";
import { formatLastTool, formatWidgetLines } from "../widget.mjs";

test("empty fleet returns undefined", () => {
  assert.equal(formatWidgetLines([], 0), undefined);
  assert.equal(formatWidgetLines(undefined, 0), undefined);
});

test("running and queued rows plus a queued count", () => {
  const lines = formatWidgetLines(
    [
      {
        type: "scout",
        description: "auth entry points",
        status: "running",
        turns: 3,
        maxTurns: 30,
        toolUses: 3,
        tokens: 12400,
        lastTool: "grep src/auth",
      },
      { type: "reviewer", description: "tests", status: "queued" },
    ],
    1,
  );
  assert.deepEqual(lines, [
    "● Agents",
    "├─ ⠹ scout  auth entry points · ↻3≤30 · 3 tools · 12.4k",
    "│    ⎿  grep src/auth",
    "├─ ⠹ reviewer  tests · queued",
    "└─ 1 queued",
  ]);
});

test("formatLastTool previews common tools", () => {
  assert.equal(formatLastTool({ toolName: "bash", args: { command: "git log -1" } }), "$ git log -1");
  assert.equal(formatLastTool({ toolName: "read", args: { path: "src/a.ts" } }), "read src/a.ts");
  assert.equal(formatLastTool({ toolName: "grep", input: { pattern: "TODO" } }), "grep TODO");
});
