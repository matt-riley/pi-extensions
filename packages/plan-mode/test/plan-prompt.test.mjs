import { test } from "node:test";
import assert from "node:assert/strict";

import { PLAN_MODE_PROMPT } from "../plan-prompt.mjs";
import { promptSection } from "../question.mjs";

test("the plan prompt is its own module, so tests can read what the model is told", () => {
  assert.match(PLAN_MODE_PROMPT, /^# Plan Mode \(read-only\)/);
  assert.match(PLAN_MODE_PROMPT, /plan_mode_complete/);
});

test("inside plan mode the plan prompt is the section that is added", () => {
  assert.deepEqual(promptSection(true, PLAN_MODE_PROMPT), ["plan_mode", PLAN_MODE_PROMPT]);
});
