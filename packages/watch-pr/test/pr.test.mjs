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
  assert.equal(none.verdict, "unknown");
  assert.match(none.lines.join("\n"), /a gap, not a pass/);
});

test("unknown check results cannot become passes or readiness", () => {
  for (const check of [
    run("ci", "COMPLETED", null),
    run("ci", "COMPLETED", "STALE"),
    run("ci", "COMPLETED", "FUTURE_CONCLUSION"),
    run("ci", "FUTURE_STATUS"),
    { __typename: "StatusContext", context: "ci", state: "FUTURE_STATE" },
    null,
  ]) {
    assert.equal(checkOutcome(check).outcome, "unknown");
    const out = assess({ pr: pr({ statusCheckRollup: [check] }), threads: [] });
    assert.equal(out.verdict, "unknown");
    assert.doesNotMatch(out.lines.join("\n"), /nothing outstanding/);
  }
});

test("unavailable review evidence is unknown even while checks are pending", () => {
  for (const snapshot of [
    { pr: pr() },
    { pr: pr(), threads: [], note: "review threads unavailable: graphql call failed" },
    {
      pr: pr({ statusCheckRollup: [run("ci", "QUEUED")] }),
      threads: [],
      note: "review threads unavailable: graphql call failed",
    },
  ]) {
    const out = assess(snapshot);
    assert.equal(out.verdict, "unknown");
    assert.match(out.lines.join("\n"), /threads unavailable/);
  }
});

test("required reviews and GitHub policy blocks need action", () => {
  for (const over of [
    { reviewDecision: "REVIEW_REQUIRED" },
    { mergeStateStatus: "BLOCKED" },
    { isDraft: true },
  ])
    assert.equal(assess({ pr: pr(over), threads: [] }).verdict, "needs-action");
});

test("missing head and unknown PR or merge states cannot report readiness", () => {
  for (const over of [
    { headRefOid: "" },
    { state: "FUTURE_STATE" },
    { mergeStateStatus: "UNKNOWN" },
    { mergeStateStatus: "FUTURE_STATE" },
    { reviewDecision: "FUTURE_STATE" },
  ])
    assert.equal(assess({ pr: pr(over), threads: [] }).verdict, "unknown");
});

test("known blockers remain actionable when other evidence is incomplete", () => {
  assert.equal(
    assess({ pr: pr({ mergeStateStatus: "DIRTY", statusCheckRollup: [] }), threads: [] }).verdict,
    "needs-action",
  );
});

test("a merged PR is closed", () => {
  assert.equal(assess({ pr: pr({ state: "MERGED" }), threads: [] }).verdict, "closed");
});

const thread = { isResolved: false, isOutdated: false, path: "later-page.ts" };
const threadPage = (nodes, { more = false, head = pr().headRefOid } = {}) => ({
  data: {
    repository: {
      pullRequest: {
        headRefOid: head,
        reviewThreads: {
          nodes,
          pageInfo: { hasNextPage: more, endCursor: more ? "next" : null },
        },
      },
    },
  },
});

function fakeGh({
  pullRequest = pr(),
  pages = [threadPage([])],
  graph = JSON.stringify(pages),
} = {}) {
  const calls = [];
  return {
    calls,
    exec: async (args) => {
      calls.push(args);
      if (args[0] === "pr") return JSON.stringify(pullRequest);
      if (args[0] === "repo")
        return JSON.stringify({ owner: { login: "workspace-owner" }, name: "workspace-repo" });
      return graph;
    },
  };
}

test("fetchSnapshot collects later-page threads instead of silently declaring ready", async () => {
  const { exec, calls } = fakeGh({
    pages: [threadPage([], { more: true }), threadPage([thread])],
  });
  const snap = await fetchSnapshot(exec);
  assert.equal(snap.threads.length, 1);
  assert.equal(assess(snap).verdict, "needs-action");
  assert.match(assess(snap).lines.join("\n"), /unresolved thread on later-page\.ts/);
  const query = calls.find((args) => args[0] === "api");
  assert.ok(query.includes("--paginate") && query.includes("--slurp"));
  assert.match(
    query.find((arg) => arg.startsWith("query=")),
    /after:\s*\$endCursor/,
  );
});

test("review queries follow the PR URL rather than the current workspace repository", async () => {
  const { exec, calls } = fakeGh({
    pullRequest: pr({ url: "https://git.example.test/other/project/pull/7" }),
  });
  const snap = await fetchSnapshot(exec, "https://git.example.test/other/project/pull/7");
  assert.equal(assess(snap).verdict, "ready");
  const query = calls.find((args) => args[0] === "api");
  assert.ok(query.includes("o=other"));
  assert.ok(query.includes("r=project"));
  assert.equal(query[query.indexOf("--hostname") + 1], "git.example.test");
});

test("failed, malformed and incomplete review responses never become empty successful reviews", async () => {
  for (const graph of [
    null,
    "{not json",
    "[]",
    JSON.stringify([{}]),
    JSON.stringify([{ ...threadPage([]), errors: [{ message: "partial result" }] }]),
    JSON.stringify([threadPage(null)]),
    JSON.stringify([threadPage([{}])]),
    JSON.stringify([threadPage([], { more: true })]),
  ]) {
    const snap = await fetchSnapshot(fakeGh({ graph }).exec);
    assert.match(snap.note, /threads unavailable/);
    assert.equal(assess(snap).verdict, "unknown");
  }
});

test("review pages from another head cannot establish readiness", async () => {
  for (const head of ["different-head", null]) {
    const snap = await fetchSnapshot(
      fakeGh({ pages: [threadPage([], { more: true }), threadPage([], { head })] }).exec,
    );
    assert.equal(assess(snap).verdict, "unknown");
    assert.match(snap.note, /head.*changed|head.*unavailable/i);
  }
});

test("closed PRs need no review query and fetch failures stay explicit", async () => {
  const { exec, calls } = fakeGh({ pullRequest: pr({ state: "MERGED" }) });
  assert.equal(assess(await fetchSnapshot(exec)).verdict, "closed");
  assert.equal(calls.length, 1);
  assert.match((await fetchSnapshot(async () => null)).error, /could not read/);
  assert.match((await fetchSnapshot(async () => "{not json")).error, /invalid.*JSON/i);
});

test("invalid PR URLs cannot query a different pull request", async () => {
  for (const url of [
    "not a URL",
    "https://github.com/o/r/pull/99",
    "https://github.com/o/r/issues/7",
  ]) {
    const { exec, calls } = fakeGh({ pullRequest: pr({ url }) });
    const snap = await fetchSnapshot(exec);
    assert.equal(assess(snap).verdict, "unknown");
    assert.equal(calls.length, 1);
  }
});
