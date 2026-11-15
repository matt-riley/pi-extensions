import { test } from "node:test";
import assert from "node:assert/strict";

import { planProblem } from "../plan-shape.mjs";

const plan = (verification) =>
  [
    "# Retry limits",
    "",
    "## Context",
    "Retries are unbounded today.",
    "",
    "## Approach",
    "- Read the limit in packages/client/retry.mjs.",
    "",
    verification,
  ].join("\n");

test("a plan with a verification section that says something passes", () => {
  const text = plan(
    "## Verification\n- Run `node --test packages/client` and watch the retry test fail first.",
  );
  assert.equal(planProblem(text), null);
});

test("a heading that names testing or a test plan counts as the verification section", () => {
  for (const heading of [
    "## Test plan",
    "### How to verify",
    "## Testing",
    "# Verification steps",
  ]) {
    const text = plan(
      `${heading}\nRun the client tests and exercise a failing request end to end.`,
    );
    assert.equal(planProblem(text), null, heading);
  }
});

test("a plan with no verification section is refused, and the reason says what to add", () => {
  const problem = planProblem(plan(""));
  assert.match(problem, /no verification section/i);
  assert.match(problem, /## Verification/);
  assert.match(problem, /plan_mode_complete/);
});

test("a verification heading with nothing under it does not count", () => {
  assert.match(planProblem(plan("## Verification\n")), /no verification section/i);
  assert.match(
    planProblem(plan("## Verification\nTBD\n\n## Assumptions\nNone.")),
    /no verification/i,
  );
});

test("a verification word in the prose is not a section", () => {
  const text =
    "# Plan\n\n## Approach\nWe will verify it later and test it somehow, in due course.\n";
  assert.match(planProblem(text), /no verification section/i);
});

test("the section ends at the next heading, so a later heading's text is not its body", () => {
  const text = plan("## Verification\n\n## Assumptions\nThe client tests are slow but reliable.");
  assert.match(planProblem(text), /no verification section/i);
});

test("a # comment inside a fenced block is not a heading, so it does not end the section", () => {
  const text = plan(
    "## Verification\n```bash\n# build the client first\nnode --test packages/client\n```\nThe retry test must fail first.",
  );
  assert.equal(planProblem(text), null);
});

test("a heading inside a fence does not count as a verification section", () => {
  const text = plan("## Notes\n```md\n## Verification\nRun every test and read the output.\n```");
  assert.match(planProblem(text), /no verification section/i);
});

test("subsections count as part of the verification section", () => {
  const text = plan(
    "## Verification\n### Unit\nRun `node --test packages/client` and see the retry test pass.\n### End to end\nStart the server and send a failing request.",
  );
  assert.equal(planProblem(text), null);
});

test("a subsection ends at the next heading of the same or a higher level", () => {
  const text = plan(
    "## Verification\n### Unit\n\n### Notes\nThe client tests are slow but reliable.\n\n## Assumptions\nNone.",
  );
  // The parent owns the text of its subsections.
  assert.equal(planProblem(text), null);
  const empty = plan(
    "## Verification\n### Unit\n\n## Assumptions\nThe client tests are slow but reliable.",
  );
  assert.match(planProblem(empty), /no verification section/i);
});
