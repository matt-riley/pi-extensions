import assert from "node:assert/strict";
import test from "node:test";
import { acceptanceExecuted } from "./workflow-eval/scoring.mjs";
const argv = ["node", "main.mjs", "1.5", "2"];
function events(command, isError = false) {
  return [
    { type: "tool_execution_start", toolName: "bash", toolCallId: "1", args: { command } },
    {
      type: "tool_execution_end",
      toolCallId: "1",
      isError,
      result: { content: [{ type: "text", text: "3.5" }] },
    },
  ];
}
test("pilot recognizes actual invocation shapes without matching quoted or skipped commands", () => {
  for (const command of [
    "node main.mjs 1.5 2",
    "node main.mjs 1.5 2 | od -c",
    "cd /fixture && node main.mjs 1.5 2; echo done",
  ])
    assert.equal(acceptanceExecuted(events(command), argv, "/fixture"), true);
  for (const command of [
    "echo 'node main.mjs 1.5 2'",
    "false && node main.mjs 1.5 2",
    "echo skipped; exit 0; node main.mjs 1.5 2",
    "if false; then\nnode main.mjs 1.5 2; fi",
    "node main.mjs 1.5 20",
    "false || node main.mjs 1.5 2",
  ])
    assert.equal(acceptanceExecuted(events(command), argv, "/fixture"), false);
  assert.equal(acceptanceExecuted(events("node main.mjs 1.5 2", true), argv, "/fixture"), false);
});
