import assert from "node:assert/strict";
import test from "node:test";

import { assess, checkOutcome, fetchSnapshot } from "../pr.mjs";

const pr = (over = {}) => ({
  number: 7,
  url: "https://github.com/o/r/pull/7",
  state: "OPEN",
  isDraft: false,
  headRefOid: "abcdef1234567890",
  baseRefName: "main",
  mergeStateStatus: "CLEAN",
  reviewDecision: "APPROVED",
  statusCheckRollup: [
    { __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS" },
  ],
  ...over,
});
const run = (name, status, conclusion) => ({ __typename: "CheckRun", name, status, conclusion });

test("checkOutcome reads check runs and commit statuses", () => {
  assert.equal(checkOutcome(run("a", "COMPLETED", "SKIPPED")).outcome, "passed");
  assert.equal(checkOutcome(run("a", "IN_PROGRESS")).outcome, "pending");
  assert.equal(checkOutcome(run("a", "COMPLETED", "TIMED_OUT")).outcome, "failed");
  assert.equal(
    checkOutcome({ __typename: "StatusContext", context: "s", state: "ERROR" }).outcome,
    "failed",
  );
  assert.equal(
    checkOutcome({ __typename: "StatusContext", context: "s", state: "PENDING" }).outcome,
    "pending",
  );
});

test("a clean PR is ready and says it is not a merge grant", () => {
  const out = assess({ pr: pr(), threads: [] });
  assert.equal(out.verdict, "ready");
  assert.match(out.lines.join("\n"), /abcdef12/);
  assert.match(out.lines.join("\n"), /not authority to merge/);
});

test("failure, conflict, behind and unresolved threads each need action", () => {
  const out = assess({
    pr: pr({
      mergeStateStatus: "DIRTY",
      statusCheckRollup: [run("lint", "COMPLETED", "FAILURE"), run("slow", "IN_PROGRESS")],
    }),
    threads: [
      {
        isResolved: false,
        isOutdated: false,
        path: "a.ts",
        comments: { nodes: [{ body: "why?" }] },
      },
      { isResolved: true, isOutdated: false, path: "b.ts" },
      { isResolved: false, isOutdated: true, path: "c.ts" },
    ],
  });
  assert.equal(out.verdict, "needs-action");
  const text = out.lines.join("\n");
  assert.match(text, /conflicts/);
  assert.match(text, /check failed: lint/);
  assert.match(text, /unresolved thread on a\.ts: why\?/);
  assert.doesNotMatch(text, /b\.ts|c\.ts/);
  assert.equal(
    assess({ pr: pr({ mergeStateStatus: "BEHIND" }), threads: [] }).verdict,
    "needs-action",
  );
});

test("only pending checks is pending; no checks is flagged, not passed", () => {
  const pending = assess({ pr: pr({ statusCheckRollup: [run("ci", "QUEUED")] }), threads: [] });
  assert.equal(pending.verdict, "pending");
  const none = assess({ pr: pr({ statusCheckRollup: [] }), threads: [] });
  assert.match(none.lines.join("\n"), /a gap, not a pass/);
});

test("a merged PR is closed", () => {
  assert.equal(assess({ pr: pr({ state: "MERGED" }), threads: [] }).verdict, "closed");
});

test("fetchSnapshot assembles PR and threads, and degrades when threads fail", async () => {
  const replies = {
    "pr view": JSON.stringify(pr()),
    "repo view": JSON.stringify({ owner: { login: "o" }, name: "r" }),
    api: JSON.stringify({
      data: {
        repository: {
          pullRequest: { reviewThreads: { nodes: [{ isResolved: false, path: "x" }] } },
        },
      },
    }),
  };
  const exec = async (args) => replies[args.slice(0, 2).join(" ")] ?? replies[args[0]] ?? null;
  const snap = await fetchSnapshot(exec);
  assert.equal(snap.threads.length, 1);
  const broken = await fetchSnapshot(async (args) => (args[0] === "api" ? null : exec(args)));
  assert.match(broken.note, /threads unavailable/);
  assert.match((await fetchSnapshot(async () => null)).error, /could not read/);
});
