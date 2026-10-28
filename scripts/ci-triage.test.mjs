import assert from "node:assert/strict";
import test from "node:test";

import {
  CLASSES,
  buildQuestionSet,
  buildTriageState,
  classifyCi,
  formatTriage,
  logTail,
  routeTriage,
} from "./ci-triage.mjs";

const choice = (value, confidence = 0.8) => ({
  type: "choice",
  choice: value,
  confidence,
  probabilities: { [value]: confidence },
});

test("the classes cover the five actions a failure calls for", () => {
  assert.deepEqual(Object.keys(CLASSES).sort(), [
    "configuration",
    "dependency",
    "flaky",
    "infra",
    "regression",
  ]);
  for (const [name, description] of Object.entries(CLASSES)) {
    assert.equal(typeof description, "string", name);
    assert.ok(description.length > 40, name);
  }
});

test("the state keeps the tail of the log and says when it cut", () => {
  const short = logTail("one line");
  assert.deepEqual(short, { text: "one line", truncated: false });
  const long = logTail("x".repeat(30) + "ERROR: the last line", 20);
  assert.equal(long.text.length, 20);
  assert.equal(long.truncated, true);
  assert.match(long.text, /last line$/);
});

test("the state carries the step and the attempt history, never negative", () => {
  const { state } = buildTriageState({ step: "npm run check", log: "boom", reruns: 2 });
  assert.equal(state.failing_step, "npm run check");
  assert.equal(state.prior_reruns, 2);
  assert.equal(buildTriageState({ log: "x", reruns: -3 }).state.prior_reruns, 0);
  assert.equal(buildTriageState({ log: "x", reruns: "nonsense" }).state.prior_reruns, 0);
  assert.equal(buildTriageState({ log: "x" }).state.failing_step, null);
});

test("the question names its state paths", () => {
  const [question] = Object.values(buildQuestionSet());
  assert.equal(question.type, "choice");
  assert.match(question.instructions, /`log`/);
  assert.match(question.instructions, /`prior_reruns`/);
});

test("a class outside the set is not a classification", () => {
  assert.equal(routeTriage({ kind: choice("flaky") }).kind, "flaky");
  assert.equal(routeTriage({ kind: choice("vibes") }), null);
  assert.equal(routeTriage({ kind: { type: "noul", noul: 0.9 } }), null);
  assert.equal(routeTriage({}), null);
});

test("the report names the class, its confidence and what to do about it", () => {
  const text = formatTriage(routeTriage({ kind: choice("regression", 0.91) }));
  assert.match(text, /^kind: regression \(confidence 0\.91\)/);
  assert.match(text, /regression 0\.91/);
  assert.match(text, /This change broke it/);
  assert.equal(formatTriage({}), "No usable classification.");
});

test("an empty log costs no request", async () => {
  let called = false;
  const result = await classifyCi({
    log: "   ",
    ask: async () => {
      called = true;
    },
  });
  assert.equal(called, false);
  assert.equal(result.judged, false);
  assert.match(result.reason, /empty/);
});

test("a classification is returned with the model and usage", async () => {
  const calls = [];
  const result = await classifyCi({
    step: "npm run check",
    log: "Error: listen EADDRINUSE",
    reruns: 1,
    env: {},
    ask: async (request) => {
      calls.push(request);
      return { model: "test", usage: { input_tokens: 10 }, answers: { kind: choice("infra") } };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].state.prior_reruns, 1);
  assert.equal(result.judged, true);
  assert.equal(result.kind, "infra");
  assert.equal(result.model, "test");
});

test("a failed request is reported, not guessed", async () => {
  const result = await classifyCi({
    log: "boom",
    env: {},
    ask: async () => {
      throw new Error("TypeSafe request failed with status 500");
    },
  });
  assert.equal(result.judged, false);
  assert.match(result.reason, /status 500/);
});
