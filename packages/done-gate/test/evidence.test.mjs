// A "tests passed" claim is checked against the runs the gate recorded: it must
// name a check that ran the code, that passed, and whose log does not say
// otherwise. Pure functions here; the extension wiring is in extension.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";

import { claimsTestsPassed, logText, testClaimGap } from "../evidence.mjs";

const run = (overrides = {}) => ({
  command: "npm test",
  kind: "behavior",
  status: "passed",
  log: "# tests 5\n# pass 5\n# fail 0\n",
  ...overrides,
});

test("claimsTestsPassed reads a plain statement that tests or checks passed", () => {
  for (const claim of [
    "All tests pass.",
    "I ran the suite and everything is green.",
    "Done. 42 tests passed and the lint is clean.",
    "The checks passed locally.",
    "npm test passes now",
    "The specs are passing.",
  ]) {
    assert.equal(claimsTestsPassed(claim), true, claim);
  }
});

test("claimsTestsPassed leaves a claim that names a gap, or says nothing about tests", () => {
  for (const claim of [
    "All tests pass except the two timing ones.",
    "I did not run the tests.",
    "The tests failed on the second run.",
    "I couldn't get the test suite to pass.",
    "No tests were affected.",
    "I fixed the retry logic and updated the README.",
    "typecheck passes",
    "",
    undefined,
  ]) {
    assert.equal(claimsTestsPassed(claim), false, String(claim));
  }
});

test("a claim a clean test run backs has no gap", () => {
  assert.equal(testClaimGap({ claim: "All 5 tests pass.", runs: [run()], edited: true }), null);
});

test("a claim with no run behind it names that, once there are edits or a lint-only run", () => {
  assert.match(
    testClaimGap({ claim: "Tests pass.", runs: [], edited: true }),
    /no check was recorded/i,
  );
  assert.equal(testClaimGap({ claim: "Tests pass.", runs: [], edited: false }), null);
  assert.match(
    testClaimGap({
      claim: "Tests pass.",
      runs: [run({ command: "tsc --noEmit", kind: "static" })],
      edited: false,
    }),
    /only compile or lint checks were recorded/i,
  );
});

test("a failed or unmatched newest run does not back the claim", () => {
  assert.match(
    testClaimGap({ claim: "Tests pass.", runs: [run({ status: "failed" })], edited: true }),
    /`npm test` failed/,
  );
  assert.match(
    testClaimGap({ claim: "Tests pass.", runs: [run({ status: "unknown" })], edited: true }),
    /no clean result on the final tree/,
  );
});

test("the newest run that executes the code decides, and a later lint run does not hide it", () => {
  const runs = [run(), run({ status: "failed" }), run({ command: "oxlint .", kind: "static" })];
  assert.match(testClaimGap({ claim: "Tests pass.", runs, edited: true }), /failed/);
  const fixed = [run({ status: "failed" }), run()];
  assert.equal(testClaimGap({ claim: "Tests pass.", runs: fixed, edited: true }), null);
});

test("a log that reports failures contradicts a run that exited 0", () => {
  for (const log of [
    "# tests 5\n# pass 4\n# fail 1\n",
    "Tests: 1 failed, 4 passed, 5 total",
    "FAIL src/a.test.js\n",
    "3 failing\n",
  ]) {
    assert.match(
      testClaimGap({ claim: "Tests pass.", runs: [run({ log })], edited: true }),
      /log of .* reports failures/,
      log,
    );
  }
});

test("a log that shows no tests ran does not back a tests-passed claim", () => {
  for (const log of [
    "# tests 0\n# pass 0\n# fail 0\n",
    "Ran 0 tests in 0.0s",
    "collected 0 items",
    "No tests found",
  ]) {
    assert.match(
      testClaimGap({ claim: "Tests pass.", runs: [run({ log })], edited: true }),
      /no tests ran/,
      log,
    );
  }
});

test("a test count in the claim must appear in the log", () => {
  assert.match(
    testClaimGap({ claim: "All 12 tests pass.", runs: [run()], edited: true }),
    /says 12 tests, the log of .* does not show 12/,
  );
  assert.equal(testClaimGap({ claim: "All 5 tests pass.", runs: [run()], edited: true }), null);
  // No log text to compare with (a background run, an empty result): nothing to contradict.
  assert.equal(
    testClaimGap({ claim: "All 12 tests pass.", runs: [run({ log: "" })], edited: true }),
    null,
  );
});

test("logText joins the text parts of a tool result and keeps the tail", () => {
  const content = [
    { type: "text", text: "a".repeat(5000) },
    { type: "image", data: "x" },
    { type: "text", text: "# fail 0" },
  ];
  const text = logText(content);
  assert.ok(text.endsWith("# fail 0"));
  assert.ok(text.length <= 4000);
  assert.equal(logText(undefined), "");
  assert.equal(logText("raw output"), "raw output");
});
