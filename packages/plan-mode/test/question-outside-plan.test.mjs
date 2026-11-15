import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ASK_USER_PROMPT,
  QUESTION_DESCRIPTION,
  QUESTION_LABEL,
  promptSection,
} from "../question.mjs";

test("outside plan mode the prompt tells the agent plan_mode_question exists", () => {
  const [name, text] = promptSection(false, "PLAN PROMPT");
  assert.equal(name, "ask_user");
  assert.equal(text, ASK_USER_PROMPT);
  assert.match(text, /plan_mode_question/);
  assert.match(text, /tool search|load/i);
});

test("inside plan mode the plan prompt is the only section", () => {
  assert.deepEqual(promptSection(true, "PLAN PROMPT"), ["plan_mode", "PLAN PROMPT"]);
});

test("the outside-plan prompt keeps the rule: only decisions go to the user", () => {
  assert.match(ASK_USER_PROMPT, /cannot be found|discover/i);
  assert.match(ASK_USER_PROMPT, /answered from context|inferred|judge/i);
  assert.ok(ASK_USER_PROMPT.length < 900, "stays short: it rides on every non-plan prompt");
});

test("the question tool is not labelled or described as plan-only", () => {
  assert.doesNotMatch(QUESTION_LABEL, /plan/i);
  assert.doesNotMatch(QUESTION_DESCRIPTION, /finalizing the plan/i);
  assert.match(QUESTION_DESCRIPTION, /plan mode and (while )?implement/i);
  // The ask-gate still sits in front of the dialog.
  assert.match(QUESTION_DESCRIPTION, /discovered by read-only exploration|discoverable/i);
});
