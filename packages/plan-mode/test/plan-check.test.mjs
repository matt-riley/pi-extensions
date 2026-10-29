import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildComprehensionQuestions,
  buildReaderAgent,
  buildReaderTask,
  extractPlanGoal,
  formatComprehensionAppendix,
  parseReaderReport,
  runPlanComprehensionCheck,
} from "../plan-check.mjs";

const FIXTURE_PLAN = [
  "# Add retry to upload",
  "",
  "Retry failed uploads up to three times before surfacing an error.",
  "",
  "## Steps",
  "",
  "- Change `src/upload.mjs` (called from `src/cli.mjs`); verify with `npm test`.",
  "",
].join("\n");

const FIXTURE_PATH = "/proj/.pi/PLAN.md";

const READER_REPORT = [
  "## What the plan changes",
  "",
  "Upload retries transient failures instead of failing immediately.",
  "",
  "## How it will be done",
  "",
  "Edit upload.mjs and add a loop; cli.mjs keeps calling upload.",
  "",
  "## Gaps",
  "",
  "- Which errors count as transient is never defined.",
  "- No mention of backoff between retries.",
  "",
].join("\n");

const noul = (value) => ({ type: "noul", noul: value });

test("the reader agent is read-only and pinned to cross-family", () => {
  const agent = buildReaderAgent();
  assert.equal(agent.model, "cross-family");
  assert.match(agent.systemPrompt, /read-only|cannot edit/i);
  assert.match(agent.systemPrompt, /cannot edit, write, install, or spawn/i);
});

test("the reader task names only the plan path, not chat or plan body", () => {
  const task = buildReaderTask(FIXTURE_PATH);
  assert.match(task, new RegExp(FIXTURE_PATH.replace(/\./g, "\\.")));
  assert.doesNotMatch(task, /Retry failed uploads/);
  assert.doesNotMatch(task, /chat history/i);
});

test("extractPlanGoal takes the title line", () => {
  assert.equal(extractPlanGoal(FIXTURE_PLAN), "Add retry to upload");
});

test("parseReaderReport pulls the two restatement headings and gaps", () => {
  const parsed = parseReaderReport(READER_REPORT);
  assert.match(parsed.whatChanges, /Upload retries/);
  assert.match(parsed.howDone, /Edit upload/);
  assert.equal(parsed.gaps.length, 2);
  assert.match(parsed.gaps[0], /transient/);
});

test("Jev asks whether the restatement matches the goal and hidden dependencies exist", () => {
  const questions = buildComprehensionQuestions();
  assert.ok(questions.same_as_goal);
  assert.ok(questions.unstated_dependency);
  assert.equal(questions.same_as_goal.type, "noul");
});

const stubModel = async () => "anthropic/claude-test";

test("with no plan file, check reports that and produces no appendix", async () => {
  const result = await runPlanComprehensionCheck({
    planPath: null,
    planText: "",
    cwd: "/tmp",
    resolveModel: stubModel,
    runChild: async () => {
      throw new Error("should not run");
    },
  });
  assert.equal(result.appendix, null);
  assert.match(result.notify, /no plan/i);
});

test("a failed reader is not run, never reported as no gaps", async () => {
  const result = await runPlanComprehensionCheck({
    planPath: FIXTURE_PATH,
    planText: FIXTURE_PLAN,
    cwd: "/tmp",
    resolveModel: stubModel,
    runChild: async () => ({ status: "timed out", text: "", turns: 1 }),
  });
  assert.ok(result.appendix);
  assert.match(result.appendix, /reader.*not run/i);
  assert.match(result.appendix, /timed out/i);
  assert.doesNotMatch(result.appendix, /\(none identified\)/i);
  assert.doesNotMatch(result.appendix, /no gaps/i);
});

test("an errored or aborted reader is not run with the reason", async () => {
  for (const status of ["error", "aborted"]) {
    const result = await runPlanComprehensionCheck({
      planPath: FIXTURE_PATH,
      planText: FIXTURE_PLAN,
      cwd: "/tmp",
      resolveModel: stubModel,
      runChild: async () => ({ status, text: "", error: "boom" }),
    });
    assert.match(result.appendix, /reader.*not run/i);
    assert.match(result.appendix, /boom|error|aborted/i);
  }
});

test("Jev failure still appends restatement and gaps; verdict is not run", async () => {
  const result = await runPlanComprehensionCheck({
    planPath: FIXTURE_PATH,
    planText: FIXTURE_PLAN,
    cwd: "/tmp",
    resolveModel: stubModel,
    runChild: async () => ({ status: "completed", text: READER_REPORT, turns: 2 }),
    ask: async () => {
      throw new Error("NO_KEY");
    },
  });
  assert.match(result.appendix, /What the plan changes/);
  assert.match(result.appendix, /Gaps/);
  assert.match(result.appendix, /transient/);
  assert.match(result.appendix, /verdict.*not run/i);
  assert.doesNotMatch(result.appendix, /same change.*yes/i);
});

test("a missing Jev key path shows not run verdict, never a pass", async () => {
  const result = await runPlanComprehensionCheck({
    planPath: FIXTURE_PATH,
    planText: FIXTURE_PLAN,
    cwd: "/tmp",
    resolveModel: stubModel,
    runChild: async () => ({ status: "completed", text: READER_REPORT, turns: 1 }),
    ask: async () => {
      throw new Error("Set TYPESAFE_API_KEY");
    },
  });
  assert.match(result.appendix, /not run/i);
  assert.doesNotMatch(result.appendix, /Every step names/i);
});

test("a successful run includes restatement, gaps, and Jev verdict lines", async () => {
  const result = await runPlanComprehensionCheck({
    planPath: FIXTURE_PATH,
    planText: FIXTURE_PLAN,
    cwd: "/tmp",
    resolveModel: stubModel,
    runChild: async (opts) => {
      assert.equal(opts.agent.model, "cross-family");
      assert.equal(opts.maxTurns, 8);
      assert.ok(opts.timeoutMs >= 60_000);
      return { status: "completed", text: READER_REPORT, turns: 3 };
    },
    ask: async (request) => {
      assert.equal(request.state.goal, "Add retry to upload");
      assert.match(request.state.whatChanges, /Upload retries/);
      return {
        model: "test",
        answers: {
          same_as_goal: noul(0.92),
          unstated_dependency: noul(0.88),
        },
      };
    },
  });
  assert.match(result.appendix, /^## Plan comprehension check/m);
  assert.match(result.appendix, /Same change as the plan goal/);
  assert.match(result.appendix, /Depends on something the plan never states/);
});

test("runChild receives only the plan-path task, not prior messages", async () => {
  let seenTask = "";
  await runPlanComprehensionCheck({
    planPath: FIXTURE_PATH,
    planText: FIXTURE_PLAN,
    cwd: "/tmp",
    resolveModel: stubModel,
    runChild: async ({ task }) => {
      seenTask = task;
      return { status: "completed", text: READER_REPORT, turns: 1 };
    },
    ask: async () => ({
      model: "test",
      answers: { same_as_goal: noul(0.9), unstated_dependency: noul(0.1) },
    }),
  });
  assert.equal(seenTask, buildReaderTask(FIXTURE_PATH));
});

test("/plan approve is not wired to plan comprehension check", async () => {
  const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");
  const approveStart = source.indexOf('if (arg === "approve")');
  const checkStart = source.indexOf('if (arg === "check")');
  assert.ok(approveStart >= 0);
  assert.ok(checkStart >= 0);
  const approveBlock = source.slice(
    approveStart,
    checkStart > approveStart ? checkStart : approveStart + 800,
  );
  assert.doesNotMatch(approveBlock, /runPlanComprehensionCheck/);
  assert.doesNotMatch(approveBlock, /plan-check\.mjs/);
});

test("formatComprehensionAppendix never claims zero gaps when reader failed", () => {
  const text = formatComprehensionAppendix({
    goal: "g",
    readerOk: false,
    readerStatus: "timed out",
    readerReason: "timed out",
    parsed: null,
    jev: { judged: false },
  });
  assert.match(text, /not run/i);
  assert.doesNotMatch(text, /\(none identified\)/);
});

test("empty reader output is not run and never calls Jev", async () => {
  let asked = false;
  const result = await runPlanComprehensionCheck({
    planPath: FIXTURE_PATH,
    planText: FIXTURE_PLAN,
    cwd: "/tmp",
    resolveModel: stubModel,
    runChild: async () => ({ status: "completed", text: "", turns: 1 }),
    ask: async () => {
      asked = true;
    },
  });
  assert.equal(asked, false);
  assert.match(
    result.appendix,
    /Fresh-context reader: not run \(reader returned no usable report\)/,
  );
  assert.match(result.appendix, /TypeSafe verdict: not run \(reader did not finish\)/);
});

const READER_RESTATE_ONLY = [
  "## What the plan changes",
  "",
  "Upload retries transient failures instead of failing immediately.",
  "",
  "## How it will be done",
  "",
  "Edit upload.mjs and add a loop.",
  "",
].join("\n");

test("restatement without a Gaps heading names the missing section", async () => {
  const result = await runPlanComprehensionCheck({
    planPath: FIXTURE_PATH,
    planText: FIXTURE_PLAN,
    cwd: "/tmp",
    resolveModel: stubModel,
    runChild: async () => ({ status: "completed", text: READER_RESTATE_ONLY, turns: 1 }),
    ask: async () => ({
      model: "test",
      answers: { same_as_goal: noul(0.9), unstated_dependency: noul(0.1) },
    }),
  });
  assert.match(result.appendix, /\(reader gave no Gaps section\)/);
  assert.doesNotMatch(result.appendix, /\(reader listed no gaps\)/);
});
