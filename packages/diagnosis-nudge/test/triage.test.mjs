import { test } from "node:test";
import assert from "node:assert/strict";

import { validateRequest } from "../../../shared/systemone.mjs";
import {
  ADVICE,
  LEAK_WARNING,
  MAX_TRIAGE_PER_SESSION,
  buildFailureQuestions,
  judgeFailure,
  memoKeyFor,
  readTriage,
  shouldTriage,
  triageText,
} from "../triage.mjs";

const noul = (value) => ({ type: "noul", noul: value });
const choiceAnswer = (choice, confidence = 0.9) => ({
  type: "choice",
  choice,
  confidence,
  probabilities: { [choice]: confidence },
});

test("the question set names the state it is asked about", () => {
  const questions = buildFailureQuestions();
  assert.deepEqual(Object.keys(questions).sort(), ["failure_class", "leaks_secret"]);
  assert.equal(questions.failure_class.type, "choice");
  assert.equal(questions.leaks_secret.type, "noul");
  // Six labels, all with a meaning: a choice with thin criteria is a guess.
  assert.deepEqual(Object.keys(questions.failure_class.criteria).sort(), [
    "code_bug",
    "environment",
    "no_failure",
    "permission",
    "transient",
    "user_error",
  ]);
  for (const [label, meaning] of Object.entries(questions.failure_class.criteria)) {
    assert.ok(meaning && meaning.length > 10, `${label} carries its own meaning`);
  }
  assert.match(questions.failure_class.instructions, /`output`/);
  assert.match(questions.failure_class.instructions, /`action`/);
  assert.match(questions.leaks_secret.instructions, /`output`/);
});

test("readTriage keeps a usable class and ignores an invented one", () => {
  assert.deepEqual(
    readTriage({ failure_class: choiceAnswer("transient"), leaks_secret: noul(0.1) }),
    {
      failureClass: "transient",
      confidence: 0.9,
      leaksSecret: 0.1,
    },
  );
  // A label outside the criteria is not a class: it must not pick advice.
  const invented = readTriage({ failure_class: choiceAnswer("flaky_infrastructure") });
  assert.equal(invented.failureClass, null);
  assert.equal(invented.confidence, null);
  assert.equal(readTriage({}).failureClass, null);
  assert.equal(readTriage().leaksSecret, null);
  // A choice answer with no confidence falls back to its own probability.
  assert.equal(readTriage({ failure_class: choiceAnswer("code_bug", 0.8) }).confidence, 0.8);
});

test("triageText advises per class and stays quiet when it should", () => {
  assert.match(triageText({ failureClass: "code_bug", confidence: 0.9 }), /fix the code/);
  assert.match(
    triageText({ failureClass: "transient", confidence: 0.7 }),
    /retry the same command once/,
  );
  assert.match(triageText({ failureClass: "permission", confidence: 0.7 }), /ask the user/);
  assert.match(triageText({ failureClass: "environment", confidence: 0.7 }), /fix the machine/);
  assert.match(
    triageText({ failureClass: "user_error", confidence: 0.7 }),
    /arguments or the directory/,
  );

  // Below the floor, in the moment, the wrong advice is worse than none.
  assert.equal(triageText({ failureClass: "code_bug", confidence: 0.5 }), null);
  assert.equal(triageText({ failureClass: "no_failure", confidence: 1 }), null);
  assert.equal(triageText({}), null);
  assert.equal(triageText(null), null);
  // Every class that has advice is reachable.
  assert.equal(Object.keys(ADVICE).length, 5);
});

test("a leaked secret is warned about first, whatever the class", () => {
  const text = triageText({ failureClass: "code_bug", confidence: 0.9, leaksSecret: 0.97 });
  assert.ok(text.startsWith(LEAK_WARNING), "the leak comes first");
  assert.match(text, /fix the code/);
  assert.match(triageText({ leaksSecret: 0.95 }), /do not repeat the value/);
  assert.equal(triageText({ leaksSecret: 0.4, failureClass: "no_failure" }), null);
  assert.equal(triageText({ leaksSecret: null }), null);
});

test("judgeFailure clips the state, validates it, and fails open", async () => {
  const calls = [];
  const problems = [];
  const ask = async (request) => {
    calls.push(request);
    try {
      validateRequest(request);
    } catch (error) {
      problems.push(error.message);
    }
    return {
      model: "test",
      usage: null,
      answers: { failure_class: choiceAnswer("transient"), leaks_secret: noul(0.02) },
    };
  };

  const judged = await judgeFailure({
    toolName: "bash",
    action: "pnpm test",
    cwd: "/repo",
    output: "x".repeat(5000),
    ask,
  });
  assert.deepEqual(problems, [], "the request passes the production validator");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].state.tool, "bash");
  assert.equal(calls[0].state.action, "pnpm test");
  assert.equal(calls[0].state.cwd, "/repo");
  assert.ok(calls[0].state.output.length < 5000, "the output is clipped before it is sent");
  assert.equal(judged.failureClass, "transient");
  assert.equal(judged.unavailable, false);
  assert.match(triageText(judged), /retry the same command once/);

  // A provider that throws is a missing classification, never a lost tool result.
  const broken = await judgeFailure({
    toolName: "bash",
    output: "boom",
    ask: async () => {
      throw new Error("network");
    },
  });
  assert.equal(broken.unavailable, true);
  assert.equal(broken.failureClass, null);
  assert.equal(triageText(broken), null);
  assert.match(broken.reason, /network/);

  // And so is a provider that answers with nothing usable.
  const empty = await judgeFailure({
    toolName: "bash",
    output: "boom",
    ask: async () => ({ answers: {} }),
  });
  assert.equal(empty.unavailable, false);
  assert.equal(triageText(empty), null);
});

test("a repeated failure is judged once, up to a cap", () => {
  const state = { seen: new Set(), judged: 0 };
  const key = memoKeyFor({ toolName: "bash", output: "same failure" });
  assert.equal(shouldTriage(state, key), true, "first sighting is judged");
  assert.equal(shouldTriage(state, key), false, "the same failure is not judged twice");
  assert.equal(state.judged, 1);
  assert.equal(
    shouldTriage(state, memoKeyFor({ toolName: "bash", output: "other failure" })),
    true,
  );

  const capped = { seen: new Set(), judged: MAX_TRIAGE_PER_SESSION };
  assert.equal(shouldTriage(capped, "fresh"), false);
  assert.equal(capped.judged, MAX_TRIAGE_PER_SESSION, "a refusal does not spend the cap");
});

test("memoKeyFor keys on what the question actually sees", () => {
  const long = "y".repeat(4000);
  assert.equal(
    memoKeyFor({ toolName: "bash", output: long }),
    memoKeyFor({ toolName: "bash", output: long }),
  );
  assert.notEqual(
    memoKeyFor({ toolName: "bash", output: long }),
    memoKeyFor({ toolName: "edit", output: long }),
  );
  assert.notEqual(
    memoKeyFor({ toolName: "bash", output: "a" }),
    memoKeyFor({ toolName: "bash", output: "b" }),
  );
});
