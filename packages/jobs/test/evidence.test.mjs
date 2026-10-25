import test from "node:test";
import assert from "node:assert/strict";
import { completedJobCheck } from "../../../shared/job-evidence.mjs";

const revision = { head: "abc", fingerprint: "same" };
const event = (changes = {}) => ({
  toolName: "terminal_read",
  isError: false,
  details: {
    job: {
      version: 1,
      id: "owned",
      command: "npm test",
      cwd: process.cwd(),
      status: "exited",
      exit_code: 0,
      signal: null,
      cleanup_error: null,
      interacted: false,
      owner: "agent",
      before: revision,
      after: revision,
      output: "1 passed",
      ...changes,
    },
  },
});

test("actual completed status becomes a revision-bound check, never a log-derived claim", () => {
  const passed = completedJobCheck(event(), process.cwd(), revision);
  assert.equal(passed.toolName, "bash");
  assert.equal(passed.input.command, "npm test");
  assert.equal(passed.isError, false);
  assert.equal(completedJobCheck(event({ exit_code: 7 }), process.cwd(), revision).isError, true);
});

test("running, interrupted, interacted, stale, unknown and foreign evidence cannot pass", () => {
  for (const changes of [
    { status: "running", output: "all tests passed" },
    { status: "stopped" },
    { signal: "SIGTERM", exit_code: null },
    { interacted: true },
    { owner: "human" },
    { cleanup_error: "kill EPERM" },
    { exit_code: null },
    { exit_code: "0" },
    { version: 0 },
    { before: null },
    { after: null },
    { before: { ...revision, fingerprint: "earlier" } },
    { cwd: "/not-this-project" },
  ])
    assert.equal(
      completedJobCheck(event(changes), process.cwd(), revision),
      null,
      JSON.stringify(changes),
    );
  assert.equal(
    completedJobCheck(event(), process.cwd(), { ...revision, fingerprint: "newer" }),
    null,
  );
  assert.equal(completedJobCheck(event(), process.cwd(), null), null);
  assert.equal(
    completedJobCheck({ ...event(), toolName: "terminal_start" }, process.cwd(), revision),
    null,
  );
});
