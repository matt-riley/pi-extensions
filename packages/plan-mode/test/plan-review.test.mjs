import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReviewQuestions,
  formatPlanReview,
  reviewPlan,
  routePlanReview,
  splitSteps,
} from "../plan-review.mjs";

const PLAN = [
  "# Add a retry to the uploader",
  "",
  "## Steps",
  "",
  "- Add a retry loop to src/upload.mjs, used by src/cli.mjs, verified by the new unit test.",
  "- Rename the config key in src/config.mjs.",
  "- Write the migration note.",
  "",
].join("\n");

const noul = (value) => ({ type: "noul", noul: value });

test("a plan's checklist becomes its steps, markers and wrapping removed", () => {
  const steps = splitSteps(PLAN);
  assert.equal(steps.length, 3);
  assert.match(steps[0], /^Add a retry loop/);
  assert.match(steps[2], /Write the migration note/);
});

test("a plan with no list falls back to its headings, then to itself", () => {
  const headings = splitSteps(
    "## One\n\nadd a cache layer to the loader\n\n## Two\n\nremove the old one from the cache",
  );
  assert.equal(headings.length, 2);
  const prose = splitSteps("Just rewrite the loader so it retries and say why in the commit.");
  assert.deepEqual(prose, ["Just rewrite the loader so it retries and say why in the commit."]);
  assert.deepEqual(splitSteps(""), []);
});

test("short or empty plans do not become steps", () => {
  assert.deepEqual(splitSteps("- done\n- nope"), []);
});

test("the step cap keeps the state bounded", () => {
  const long = Array.from(
    { length: 30 },
    (_, index) => "- step " + index + " with enough words to count",
  ).join("\n");
  assert.equal(splitSteps(long).length, 10);
});

test("each step is asked about verification and callers", () => {
  const questions = buildReviewQuestions(2);
  assert.deepEqual(Object.keys(questions).sort(), [
    "callers_0",
    "callers_1",
    "verification_0",
    "verification_1",
  ]);
  assert.match(questions.verification_1.instructions, /`steps\.1\.text`/);
});

test("only steps that fall short are reported, worst first", () => {
  const steps = ["a", "b", "c"];
  const routed = routePlanReview(
    {
      verification_0: noul(0.9),
      verification_1: noul(0.1),
      verification_2: noul(0.3),
      callers_0: noul(0.8),
      callers_1: noul(0.2),
      callers_2: noul(0.7),
    },
    steps,
  );
  assert.deepEqual(
    routed.missingVerification.map((row) => row.index),
    [1, 2],
  );
  assert.deepEqual(
    routed.missingCallers.map((row) => row.index),
    [1],
  );
});

test("the appendix names the step and says it read the plan, not the code", () => {
  const routed = routePlanReview(
    {
      verification_0: noul(0.2),
      verification_1: noul(0.9),
      callers_0: noul(0.9),
      callers_1: noul(0.9),
    },
    ["add the cache", "add the test"],
  );
  const text = formatPlanReview(routed);
  assert.match(text, /^## Plan check/);
  assert.match(text, /No verification named:/);
  assert.match(text, /- step 1 — add the cache/);
  assert.match(text, /not of the code/);
  assert.doesNotMatch(text, /step 2/);
});

test("a plan where every step holds up says so", () => {
  const routed = routePlanReview({ verification_0: noul(0.9), callers_0: noul(0.9) }, [
    "add the cache",
  ]);
  assert.match(formatPlanReview(routed), /Every step names its verification/);
});

test("no judgment is no appendix, and no request when there is nothing to judge", async () => {
  let called = false;
  const empty = await reviewPlan({
    plan: "",
    ask: async () => {
      called = true;
    },
  });
  assert.equal(called, false);
  assert.equal(empty.appendix, null);

  const failed = await reviewPlan({
    plan: PLAN,
    env: {},
    ask: async () => {
      throw new Error("TYPEFAIL");
    },
  });
  assert.equal(failed.appendix, null);
  assert.match(failed.reason, /TYPEFAIL/);
});

test("a judged plan returns the appendix to append", async () => {
  const calls = [];
  const result = await reviewPlan({
    plan: PLAN,
    env: {},
    ask: async (request) => {
      calls.push(request);
      return {
        model: "test",
        answers: {
          verification_0: noul(0.9),
          callers_0: noul(0.9),
          verification_1: noul(0.4),
          callers_1: noul(0.9),
          verification_2: noul(0.9),
          callers_2: noul(0.9),
        },
      };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].state.steps.length, 3);
  assert.match(result.appendix, /step 2 — Rename the config key/);
});
