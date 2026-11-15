import { test } from "node:test";
import assert from "node:assert/strict";

import { approvalQuestionProblem } from "../question.mjs";

test("a question that asks for the plan's approval is refused, in the question or its options", () => {
  const asks = [
    { question: "Does this plan work for you?" },
    { question: "Shall I proceed with this plan?" },
    { question: "How does this plan look?" },
    { question: "Anything you want changed before I begin?" },
    { question: "Ready to implement?", options: ["Yes", "No"] },
    { question: "Happy for me to begin?" },
    { question: "Can I kick this off now?" },
    { question: "Want me to get going?" },
    { question: "Should I start implementing?" },
    { question: "Do you approve?" },
    { question: "Shall I go ahead and start implementing?" },
    { question: "Do you approve the plan?" },
    { title: "Approval", question: "Which way?", options: ["Looks good, proceed", "Change it"] },
  ];
  for (const ask of asks) {
    const problem = approvalQuestionProblem(ask);
    assert.match(problem ?? "", /plan_mode_complete/, JSON.stringify(ask));
    assert.match(problem, /\/plan approve/);
  }
});

test("a real decision question goes through, even when it mentions the plan or a proceed word", () => {
  const decisions = [
    { question: "Which retry strategy should the plan use?", options: ["Fixed", "Exponential"] },
    { question: "Should the client retry on a 429?", options: ["Yes", "No"] },
    { question: "Where should the limit live?", options: ["Config file", "Env var"] },
    {
      question: "Do you want me to keep the old API while I proceed with the new one?",
      options: ["Keep", "Drop"],
    },
    { question: "Which tests should the plan add?", options: ["Unit only", "Unit and e2e"] },
    { question: "Should I start with the API or the UI?", options: ["API", "UI"] },
    { question: "Should I implement this as a new module or extend the old one?" },
    { question: "Do you approve dropping the legacy endpoint?", options: ["Drop", "Keep"] },
    { question: "Should I begin with the schema change or the backfill?" },
    { question: "Want me to start with the cheaper fix, or do the full rewrite?" },
  ];
  for (const ask of decisions) {
    assert.equal(approvalQuestionProblem(ask), null, JSON.stringify(ask));
  }
});

test("an empty or odd call is not an approval question", () => {
  assert.equal(approvalQuestionProblem({}), null);
  assert.equal(approvalQuestionProblem(undefined), null);
  assert.equal(approvalQuestionProblem({ question: 42, options: "yes" }), null);
});

test("model-written text cannot make the approval check slow", () => {
  const hostile = [
    `Should I start${" and start implementing".repeat(200)}`,
    `Should I start${" and start implementing".repeat(200)} but wait`,
    `Ready to${" implementing".repeat(300)}x`,
    `Shall I go ahead${" with it and begin building".repeat(150)} later, or not?`,
    `Want me to ${"start ".repeat(400)}?`,
  ];
  for (const question of hostile) {
    const started = performance.now();
    approvalQuestionProblem({ question });
    const took = performance.now() - started;
    assert.ok(took < 100, `${took.toFixed(1)} ms for ${question.slice(0, 40)}`);
  }
});

test("a long run of begin-words is still an approval ask when it ends the sentence", () => {
  assert.match(
    approvalQuestionProblem({
      question: `Should I start${" and start implementing".repeat(50)}?`,
    }) ?? "",
    /plan_mode_complete/,
  );
});

test("a ready-to-start question about something other than the plan is a decision", () => {
  for (const question of [
    "Are you ready to start the migration window on Friday?",
    "Is the team ready to begin the rollout in staging first?",
    "Should I start with the API or the UI?",
    "Want me to build the cache layer or the queue first?",
    "Ready to begin the migration?",
  ])
    assert.equal(approvalQuestionProblem({ question }), null, question);
});
