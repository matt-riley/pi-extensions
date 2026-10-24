import assert from "node:assert/strict";
import test from "node:test";

import { extractQuotes, quoteStatus, verifyFindings, formatVerified } from "../findings.mjs";
import {
  MAX_DIFF_CHARS,
  capDiff,
  conventionalProblems,
  formatFindings,
  lintChange,
  routeFindings,
} from "../lint.mjs";
import { buildQuestionSet } from "../rules.mjs";

const DIFF = [
  "--- a/src/loader.mjs",
  "+++ b/src/loader.mjs",
  "@@ -1,3 +1,4 @@",
  "-const config = readConfig();",
  "+const config = readConfig(process.env.CONFIG_PATH);",
  " export default config;",
].join("\n");

const noul = (value) => ({ type: "noul", noul: value });
const score = (value) => ({ type: "score", score: value });

// ---------------------------------------------------------------------------
// The question set

test("a message, a task and test files each add only their own rules", () => {
  assert.deepEqual(Object.keys(buildQuestionSet({})).sort(), [
    "narrating_comment",
    "overengineered",
    "speculative_scaffolding",
    "unnecessary_dependency",
    "unrequested_abstraction",
  ]);
  const withMessage = buildQuestionSet({ message: "fix(loader): read CONFIG_PATH" });
  assert.ok("message_matches_diff" in withMessage);
  assert.ok(!("scope_creep" in withMessage));
  const withTask = buildQuestionSet({ task: "fix the loader" });
  assert.ok("scope_creep" in withTask);
  assert.ok(!("message_matches_diff" in withTask));
  assert.ok("weak_tests" in buildQuestionSet({ hasTests: true }));
  assert.ok(!("weak_tests" in buildQuestionSet({ hasTests: false })));
});

test("every question is a noul whose true answer means the rule is violated", () => {
  for (const [id, question] of Object.entries(
    buildQuestionSet({ message: "fix: x", task: "x", hasTests: true }),
  )) {
    assert.equal(question.type, "noul", id);
    assert.match(question.instructions, /diff/, id);
    assert.equal(typeof question.criteria.true, "string", id);
    assert.equal(typeof question.criteria.false, "string", id);
  }
});

// ---------------------------------------------------------------------------
// Routing

test("findings above threshold, strongest first, unusable answers dropped", () => {
  const findings = routeFindings({
    overengineered: noul(0.81),
    single_concern: noul(0.2),
    scope_creep: { type: "noul", noul: null },
    unknown_rule: noul(0.99),
  });
  assert.deepEqual(
    findings.map((finding) => [finding.id, finding.probability]),
    [["overengineered", 0.81]],
  );
});

test("a finding carries the label a person can act on", () => {
  const [finding] = routeFindings({ overengineered: noul(0.9) });
  assert.match(formatFindings([finding]), /^overengineered 0\.90 — /);
});

// ---------------------------------------------------------------------------
// The mechanical half

test("conventionalProblems checks the shape a model should not be asked to check", () => {
  assert.deepEqual(conventionalProblems("fix(loader): read CONFIG_PATH"), []);
  assert.deepEqual(conventionalProblems("Fix the loader."), [
    "subject is not type(scope): text with a known type",
  ]);
  assert.deepEqual(conventionalProblems("fix: Read the config"), [
    "subject starts with a capital letter",
  ]);
  assert.deepEqual(conventionalProblems("fix: read the config."), ["subject ends with a period"]);
  assert.deepEqual(conventionalProblems("fix: read the config\n\nBREAKING CHANGE: dropped node"), [
    "a BREAKING CHANGE footer without a ! in the subject",
  ]);
  assert.deepEqual(conventionalProblems("feat(api)!: drop node 18"), []);
});

test("a diff past the state budget is cut and says so", () => {
  const short = capDiff("abc");
  assert.deepEqual(short, { text: "abc", truncated: false });
  const long = capDiff("x".repeat(MAX_DIFF_CHARS + 10));
  assert.equal(long.text.length, MAX_DIFF_CHARS);
  assert.equal(long.truncated, true);
});

// ---------------------------------------------------------------------------
// lintChange

test("lintChange asks once with the state its questions name", async () => {
  const calls = [];
  const ask = async (request) => {
    calls.push(request);
    return { model: "test", usage: null, answers: { overengineered: noul(0.7) } };
  };
  const result = await lintChange({
    diff: DIFF,
    files: ["src/loader.mjs"],
    message: "fix(loader): read CONFIG_PATH",
    task: "make the loader read CONFIG_PATH",
    ask,
    env: {},
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].state.task, "make the loader read CONFIG_PATH");
  assert.equal(calls[0].state.diff_truncated, false);
  assert.deepEqual(
    result.findings.map((f) => f.id),
    ["overengineered"],
  );
  assert.deepEqual(result.subject, []);
});

test("lintChange reports a failed judgment instead of inventing a pass", async () => {
  const result = await lintChange({
    diff: DIFF,
    message: "fix: x",
    ask: async () => {
      throw new Error("TYPESAFE_API_KEY is not set");
    },
    env: {},
  });
  assert.equal(result.judged, false);
  assert.deepEqual(result.findings, []);
  assert.match(result.reason, /TYPESAFE_API_KEY/);
});

// ---------------------------------------------------------------------------
// Findings verification

test("quotes are found by text, not by position", () => {
  const quotes = extractQuotes(
    "The default is dropped when `readConfig(process.env.CONFIG_PATH)` throws.",
  );
  assert.deepEqual(quotes, ["readConfig(process.env.CONFIG_PATH)"]);
  assert.equal(
    quoteStatus("The default is dropped when `readConfig(process.env.CONFIG_PATH)` throws.", DIFF)
      .status,
    "found",
  );
  assert.equal(quoteStatus("`something(else)`", DIFF).status, "missing");
  assert.equal(quoteStatus("no quotation here", DIFF).status, "none");
});

test("a finding quoting code absent from the diff is dropped without a request", async () => {
  const calls = [];
  const ask = async (request) => {
    calls.push(request);
    return { model: "test", usage: null, answers: {} };
  };
  const result = await verifyFindings({
    findings: ["The `readConfigOrDefault(process.env.CONFIG_PATH)` call ignores the default."],
    diff: DIFF,
    ask,
    env: {},
  });
  assert.equal(calls.length, 0);
  assert.equal(result.kept.length, 0);
  assert.equal(result.dropped.length, 1);
  assert.match(result.dropped[0].reason, /not in the diff/);
});

test("surviving findings are asked in one request, strongest first", async () => {
  const calls = [];
  const ask = async (request) => {
    calls.push(request);
    return {
      model: "test",
      usage: null,
      answers: {
        support_0: noul(0.2),
        severity_0: score(0),
        support_1: noul(0.9),
        severity_1: score(2),
      },
    };
  };
  const result = await verifyFindings({
    findings: [
      "The `readConfig(process.env.CONFIG_PATH)` call ignores the default.",
      "No test covers the new branch.",
    ],
    diff: DIFF,
    ask,
    env: {},
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0].questions).sort(), [
    "severity_0",
    "severity_1",
    "support_0",
    "support_1",
  ]);
  assert.equal(result.kept.length, 2);
  assert.equal(result.kept[0].index, 1);
  assert.match(formatVerified(result), /^\[blocking · support 0\.90 · no quote\]/m);
});
