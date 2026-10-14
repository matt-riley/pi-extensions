import { test } from "node:test";
import assert from "node:assert/strict";

import { validateRequest } from "../../../shared/systemone.mjs";
import {
  ASK_USER,
  alwaysAsk,
  buildGateQuestions,
  decideGate,
  judgeQuestion,
  readGate,
} from "../ask-gate.mjs";

const noul = (value) => ({ type: "noul", noul: value });
const choiceAnswer = (choice, confidence) => ({
  type: "choice",
  choice,
  confidence,
  probabilities: { [choice]: confidence },
});

const OPTIONS = ["pnpm", "npm"];

test("the question set offers the options plus a way out", () => {
  const questions = buildGateQuestions(OPTIONS);
  assert.equal(questions.pick.type, "choice");
  assert.equal(questions.determined.type, "noul");
  // The escape hatch is not optional: a model that can only choose invents.
  assert.ok(ASK_USER in questions.pick.criteria);
  assert.ok(OPTIONS.every((option) => option in questions.pick.criteria));
  assert.match(questions.pick.instructions, /`request`/);
  assert.match(questions.determined.instructions, /`options`/);
});

test("preferences, money and irreversible choices are never answered for the user", () => {
  const ask = [
    "Which do you prefer: tabs or spaces?",
    "Should I delete the old migration files?",
    "Add a new dependency for YAML parsing, or hand-roll it?",
    "Shall I rewrite history to squash these commits?",
    "This costs about $40/month — do you want it?",
    "Should I rename the public API method?",
    "Do you want dark mode or light mode for the footer?",
    "Which colour should the badge be?",
  ];
  for (const question of ask) {
    assert.ok(alwaysAsk(question), `should ask the user: ${question}`);
  }
  const inferable = [
    "Which package manager should I use for zod?",
    "Which test path should the new suite live in?",
    "Should the module be .mjs or part of the entrypoint?",
    "Which Node version does CI run on?",
  ];
  for (const question of inferable) {
    assert.equal(alwaysAsk(question), null, `could be inferred: ${question}`);
  }
});

test("readGate keeps a usable pick and ignores an invented one", () => {
  const read = readGate({ pick: choiceAnswer("pnpm", 0.98), determined: noul(0.95) }, OPTIONS);
  assert.deepEqual(read, { pick: "pnpm", confidence: 0.98, determined: 0.95 });
  // An option the caller never offered cannot be selected.
  const invented = readGate({ pick: choiceAnswer("yarn", 1) }, OPTIONS);
  assert.equal(invented.pick, null);
  assert.equal(invented.confidence, null);
  assert.equal(readGate({}).pick, null);
});

test("a gate that is not certain asks the user instead", () => {
  const base = {
    question: "Which package manager should I use for zod?",
    options: OPTIONS,
    recommended: "pnpm",
    request: "add zod validation to the loaders",
  };
  const certain = { pick: "pnpm", confidence: 0.99, determined: 0.99 };

  const decided = decideGate(base, certain);
  assert.equal(decided.answer, "pnpm");
  assert.match(decided.reason, /0\.99/);

  // Every way of being unsure lands on asking.
  assert.equal(decideGate(base, { ...certain, pick: ASK_USER }).answer, null);
  assert.equal(decideGate(base, { ...certain, confidence: 0.85 }).answer, null);
  assert.equal(decideGate(base, { ...certain, determined: 0.85 }).answer, null);
  assert.equal(decideGate(base, { ...certain, pick: null }).answer, null);
  assert.equal(decideGate({ ...base, recommended: "" }, certain).answer, null);
  assert.equal(
    decideGate({ ...base, question: "Should I delete the old files?" }, certain).answer,
    null,
  );
  assert.equal(
    decideGate(base, { ...certain, determined: 0.99, total: 0 }).answer,
    "pnpm",
    "nothing else can veto a settled pick",
  );
  // The reason names the evidence, because the line goes to the user.
  assert.match(decideGate(base, { ...certain, pick: "npm" }).reason, /npm/);
});

test("judgeQuestion validates its request and fails open", async () => {
  const calls = [];
  const problems = [];
  const ask = async (request) => {
    calls.push(request);
    try {
      validateRequest(request);
    } catch (error) {
      problems.push(error.message);
    }
    return { answers: { pick: choiceAnswer("pnpm", 0.99), determined: noul(0.99) } };
  };
  const judged = await judgeQuestion({
    question: "Which package manager for zod?",
    options: OPTIONS,
    recommended: "pnpm",
    request: "add zod",
    ask,
  });
  assert.deepEqual(problems, [], "the request passes the production validator");
  assert.equal(calls[0].state.options.length, 2);
  assert.equal(judged.unavailable, false);
  assert.equal(
    decideGate(
      {
        question: "Which package manager for zod?",
        options: OPTIONS,
        recommended: "pnpm",
        request: "add zod",
      },
      judged,
    ).answer,
    "pnpm",
  );

  const broken = await judgeQuestion({
    question: "q",
    options: OPTIONS,
    ask: async () => {
      throw new Error("no key");
    },
  });
  assert.equal(broken.unavailable, true);
  assert.equal(broken.pick, null);
  assert.match(broken.reason, /no key/);
  // A refusal to ask is not an answer.
  assert.equal(
    decideGate({ question: "q", options: OPTIONS, recommended: "pnpm" }, broken).answer,
    null,
  );
});
