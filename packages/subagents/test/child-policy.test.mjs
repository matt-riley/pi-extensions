import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateChildToolCall } from "../child-policy.mjs";

const allowlist = { allowlistBash: true, blockWriters: true };

test("allowlisted git log passes", () => {
  assert.equal(
    evaluateChildToolCall({ toolName: "bash", input: { command: "git log -1" } }, allowlist),
    undefined,
  );
});

test("git checkout, npm install, and rm are blocked", () => {
  for (const command of ["git checkout main", "npm install", "rm -rf src"]) {
    const result = evaluateChildToolCall({ toolName: "bash", input: { command } }, allowlist);
    assert.ok(result?.block, command);
    assert.match(result.reason, /blocks bash command/);
  }
});

test("read-only children block edit/write and subagent", () => {
  assert.deepEqual(evaluateChildToolCall({ toolName: "edit" }, allowlist), {
    block: true,
    reason: "Read-only subagent blocks edit.",
  });
  assert.deepEqual(evaluateChildToolCall({ toolName: "write" }, allowlist), {
    block: true,
    reason: "Read-only subagent blocks write.",
  });
  assert.deepEqual(evaluateChildToolCall({ toolName: "subagent" }, allowlist), {
    block: true,
    reason: "Subagents cannot spawn subagents.",
  });
});

test("write-capable path does not apply the bash allowlist", () => {
  const open = { allowlistBash: false, blockWriters: false };
  assert.equal(
    evaluateChildToolCall({ toolName: "bash", input: { command: "git checkout main" } }, open),
    undefined,
  );
  assert.equal(evaluateChildToolCall({ toolName: "edit", input: { path: "a.ts" } }, open), undefined);
});
