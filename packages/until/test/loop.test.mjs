import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_MAX, RULE, decide, kickoffMessage, parseArgs, tail, tsvRow } from "../loop.mjs";

test("parses status, stop, command, task and --max", () => {
  assert.deepEqual(parseArgs(""), { kind: "status" });
  assert.deepEqual(parseArgs("  stop "), { kind: "stop" });
  assert.deepEqual(parseArgs("npm test"), {
    kind: "start",
    command: "npm test",
    task: "",
    max: DEFAULT_MAX,
  });
  assert.deepEqual(parseArgs("--max 5 npm test -- --grep date -- fix the date test"), {
    kind: "start",
    command: "npm test",
    task: "--grep date -- fix the date test",
    max: 5,
  });
  assert.equal(parseArgs("--max 0 npm test").kind, "error");
  assert.equal(parseArgs("--max 5").kind, "error");
});

const loop = { command: "npm test", task: "", max: 3, iteration: 0, logPath: "/dev/null" };

test("a passing predicate ends the loop", () => {
  assert.equal(decide(loop, "completed", { code: 0, stdout: "ok" }).action, "done");
});

test("a failing predicate continues with the output tail and the rule", () => {
  const d = decide(loop, "completed", { code: 1, stdout: "1 failing\nexpected 2", stderr: "" });
  assert.equal(d.action, "continue");
  assert.equal(d.iteration, 1);
  assert.match(d.message, /expected 2/);
  assert.ok(d.message.includes(RULE));
  assert.equal(d.summary, "exit 1: 1 failing");
});

test("stops at the cap rather than looping forever", () => {
  const d = decide({ ...loop, iteration: 2 }, "completed", { code: 1, stdout: "no" });
  assert.equal(d.action, "cap");
});

test("an aborted or errored run halts the loop", () => {
  assert.equal(decide(loop, "aborted", { code: -1 }).action, "halt");
  assert.equal(decide(loop, "error", { code: -1 }).action, "halt");
});

test("tail keeps the last lines", () => {
  assert.equal(tail("a\nb\nc\n", 2), "b\nc");
});

test("tsv rows are single-line and formula safe", () => {
  assert.equal(tsvRow(["a\tb", "x\ny", "=SUM(1)"]), "a b\tx y\t'=SUM(1)\n");
});

test("kickoff falls back to the predicate when no task is given", () => {
  assert.match(kickoffMessage(loop), /^Make `npm test` exit 0\./);
});
