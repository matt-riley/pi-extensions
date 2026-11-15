import { test } from "node:test";
import assert from "node:assert/strict";

import { buildCoachQuestions } from "../battery.mjs";

// /improve writes deeper rewrites (read sources, name methods, end with a check).
// A judge told to treat anything beyond "clearer" as drift scored those 0.2-0.56
// against a 0.7 threshold, so real improvements were thrown away. Measured live
// on TypeSafe: good deeper rewrites 0.89-0.93, scope-changing ones at or below 0.13.
test("the intent question accepts depth moves and still rejects scope changes", () => {
  const { instructions, criteria } = buildCoachQuestions().intent_preserved;
  assert.match(instructions, /deeper version/);
  assert.match(instructions, /check the agent can run/);
  assert.match(instructions, /read files, logs, or test output first/);
  assert.match(instructions, /adds a feature, deliverable, deadline, or requirement/);
  assert.match(instructions, /file path that appears neither/);
  assert.doesNotMatch(instructions, /omits important intent/);
  assert.match(criteria.true, /more thorough/);
});
