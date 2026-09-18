import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DIAGNOSIS_TOOL,
  NUDGE_TEXT,
  appendNudge,
  createNudgeState,
  observeToolResult,
  resetNudgeState,
} from "../nudge.mjs";

test("nudges once on a failure, then stays quiet until a diagnosis happens", () => {
  const state = createNudgeState();

  const first = observeToolResult(state, { toolName: "bash", isError: true });
  assert.equal(first.nudge, true);
  assert.equal(first.text, NUDGE_TEXT);

  const second = observeToolResult(state, { toolName: "bash", isError: true });
  assert.equal(second.nudge, false, "one reminder per failure streak, not per tool call");
  assert.equal(second.unaddressed, true);
});

test("a diagnosis call clears the streak and re-arms the reminder", () => {
  const state = createNudgeState();
  observeToolResult(state, { toolName: "bash", isError: true });

  observeToolResult(state, { toolName: DIAGNOSIS_TOOL, isError: false });
  assert.equal(state.unaddressed, false);
  assert.equal(state.nudged, false);

  const next = observeToolResult(state, { toolName: "bash", isError: true });
  assert.equal(next.nudge, true, "a later, unrelated failure deserves its own nudge");
});

test("a failed diagnosis call does not count as the diagnosis", () => {
  const state = createNudgeState();
  observeToolResult(state, { toolName: "bash", isError: true });
  const result = observeToolResult(state, { toolName: DIAGNOSIS_TOOL, isError: true });
  assert.equal(result.nudge, false, "never nudge about the diagnosis tool itself");
  assert.equal(state.unaddressed, false);
});

test("successes never nudge and never clear a failure", () => {
  const state = createNudgeState();
  observeToolResult(state, { toolName: "bash", isError: true });

  const success = observeToolResult(state, { toolName: "bash", isError: false });
  assert.equal(success.nudge, false);
  assert.equal(success.unaddressed, true, "a passing grep does not mean the failing test passed");

  const clean = observeToolResult(createNudgeState(), { toolName: "read", isError: false });
  assert.equal(clean.nudge, false);
});

test("handles missing fields defensively", () => {
  const state = createNudgeState();
  assert.equal(observeToolResult(state, {}).nudge, false);
  assert.equal(observeToolResult(state, undefined).nudge, false);
});

test("resetNudgeState clears everything for a new session", () => {
  const state = createNudgeState();
  observeToolResult(state, { toolName: "bash", isError: true });
  resetNudgeState(state);
  assert.deepEqual(state, { unaddressed: false, nudged: false });
});

test("appendNudge adds a block without touching the original content", () => {
  const content = [{ type: "text", text: "boom" }];
  const patched = appendNudge(content, NUDGE_TEXT);
  assert.equal(content.length, 1, "the caller's array is left alone");
  assert.deepEqual(patched, [
    { type: "text", text: "boom" },
    { type: "text", text: NUDGE_TEXT },
  ]);
  assert.equal(appendNudge(undefined, NUDGE_TEXT), undefined);
});
