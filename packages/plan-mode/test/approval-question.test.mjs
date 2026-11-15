import { test } from "node:test";
import assert from "node:assert/strict";

import { approvalQuestionProblem } from "../question.mjs";

test("a question that asks for the plan's approval is refused, in the question or its options", () => {
  const asks = [
    { question: "Is this plan okay?" },
    { question: "Should I proceed with this plan?" },
    { question: "How does this plan look?" },
    { question: "Any changes before we start?" },
    { question: "Ready to implement?", options: ["Yes", "No"] },
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
