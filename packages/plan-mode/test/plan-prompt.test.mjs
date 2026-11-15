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

const phase = (heading) => {
  const start = PLAN_MODE_PROMPT.indexOf(heading);
  assert.ok(start >= 0, `${heading} is in the prompt`);
  const next = PLAN_MODE_PROMPT.indexOf("\n## ", start + heading.length);
  return PLAN_MODE_PROMPT.slice(start, next < 0 ? undefined : next);
};

test("the prompt starts with read-only scouts: up to three, no shell, each brief standing alone", () => {
  const scouting = phase("## Phase 1");
  assert.match(scouting, /plan_scout/);
  assert.match(scouting, /up to 3/);
  assert.match(scouting, /no shell/i);
  assert.match(scouting, /stands alone/);
  assert.match(scouting, /scouts report; you decide/i);
});

test("the plan document is short and has a verification section", () => {
  const doc = phase("## The plan document");
  assert.match(doc, /## Verification/);
  assert.match(doc, /rejected/i);
  assert.match(doc, /short|one screen|scan/i);
});

test("approval has one route: plan_mode_complete, never a question or prose", () => {
  const ending = phase("## Ending each turn");
  assert.match(ending, /plan_mode_complete/);
  assert.match(ending, /do not ask whether the plan looks good/i);
  assert.match(ending, /rejected/i);
  assert.match(ending, /\/plan approve/);
});

test("the scouting, plan and ending sections have no em dashes or arrows", () => {
  for (const heading of ["## Phase 1", "## Ending each turn", "## The plan document"]) {
    assert.doesNotMatch(phase(heading), /[\u2014\u2192]/, heading);
  }
});

test("the mode rules still say bash is a read-only allowlist and installs are blocked", () => {
  assert.match(phase("## Mode rules"), /fail-closed allowlist/);
});
