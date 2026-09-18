import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ALWAYS_ON_GROUPS,
  contentWords,
  coveredBy,
  coverageReport,
  looksInjected,
  SCOPED_GROUPS,
  gateTurn,
  groupOf,
  groupsUsed,
  groundTruth,
  overlapRatio,
  scoreBinary,
  scoreRun,
  shouldRoute,
  TOOL_GROUPS,
} from "../lib.mjs";
import {
  buildQuestions,
  buildRouterState,
  routeFromAnswers,
  ROUTER_THRESHOLDS,
} from "../battery.mjs";

const noul = (value) => ({ type: "noul", noul: value });
const score = (value) => ({ type: "score", score: value });
const choice = (value) => ({ type: "choice", choice: value });

function turn(prompt, tools = []) {
  return { prompt, toolCalls: tools.map((name) => ({ name, isError: false })) };
}

// ---------------------------------------------------------------------------
// Group mapping and ground truth

test("groupOf maps the real tool names in this repo's sessions", () => {
  assert.equal(groupOf("bash"), "shell");
  assert.equal(groupOf("Bash"), "shell");
  assert.equal(groupOf("read"), "read");
  assert.equal(groupOf("code_search"), "read");
  assert.equal(groupOf("edit"), "edit");
  assert.equal(groupOf("web_search"), "web");
  assert.equal(groupOf("lore_recall"), "memory");
  assert.equal(groupOf("plan_mode_question"), "plan");
  assert.equal(groupOf("subagent"), "agents");
  assert.equal(groupOf("typesafe_ask"), "judge");
  assert.equal(groupOf("something_new"), "other");
});

test("groupsUsed reports unmapped tools instead of hiding them", () => {
  const { groups, unmapped } = groupsUsed([
    { name: "bash" },
    { name: "future_tool" },
    { name: "read" },
  ]);
  assert.deepEqual([...groups].sort(), ["read", "shell"]);
  assert.deepEqual([...unmapped], ["future_tool"]);
});

test("groundTruth reads a turn's shape", () => {
  const truth = groundTruth(turn("do it", ["bash", "edit", "bash"]));
  assert.equal(truth.toolCount, 3);
  assert.equal(truth.usedShell, true);
  assert.equal(truth.usedEdit, true);
  assert.equal(truth.usedRead, false);
  assert.equal(truth.isConversational, false);
  assert.equal(groundTruth(turn("yes", [])).isConversational, true);
});

// ---------------------------------------------------------------------------
// The gate's answer key

test("shouldRoute fires when a turn needs a group the previous turn did not", () => {
  const previous = turn("fix the parser", ["read", "edit"]);
  assert.equal(
    shouldRoute(previous, turn("now run the tests", ["read", "edit", "bash"])).route,
    true,
  );
  assert.equal(shouldRoute(previous, turn("and again", ["read", "write"])).route, false);
  assert.equal(shouldRoute(null, turn("start", ["read"])).route, true);
});

test("shouldRoute stays quiet when the groups are a subset", () => {
  const previous = turn("do everything", ["bash", "edit", "read"]);
  const result = shouldRoute(previous, turn("just read this", ["read"]));
  assert.equal(result.route, false);
  assert.deepEqual(result.added, []);
});

// ---------------------------------------------------------------------------
// The gate itself

test("gateTurn routes on the first turn and on topic shifts", () => {
  assert.equal(gateTurn({ prompt: "start here" }).route, true);
  const previous = turn("add the guardrail confirm dialog", []);
  assert.equal(
    gateTurn({
      prompt: "now measure how the routing corpus behaves over sessions",
      previousTurn: previous,
    }).route,
    true,
  );
});

test("gateTurn stays put on short follow-ups that share the topic", () => {
  const previous = turn("finish the guardrail fix then commit and push it", []);
  for (const prompt of ["push", "yes", "do it", "push please", "go ahead and push"]) {
    assert.equal(gateTurn({ prompt, previousTurn: previous }).route, false, prompt);
  }
});

test("gateTurn treats a long prompt as a new task", () => {
  const previous = turn("push", []);
  const long =
    "Please now look at the routing design and measure the context cost of a typical turn across every session so we can decide";
  assert.equal(gateTurn({ prompt: long, previousTurn: previous }).route, true);
});

test("contentWords drops filler so overlap measures topic, not politeness", () => {
  const words = contentWords("yes please do it now, thanks");
  assert.equal(words.size, 0);
  const real = contentWords("fix the guardrail routing gate");
  assert.ok(real.has("guardrail"));
  assert.ok(real.has("routing"));
  assert.ok(!real.has("the"));
});

test("overlapRatio compares against the smaller side, not the union", () => {
  assert.equal(overlapRatio("guardrail routing", "guardrail routing gate design"), 1);
  assert.equal(overlapRatio("guardrail routing", "unrelated words here"), 0);
});

// ---------------------------------------------------------------------------
// Scoring arithmetic

test("scoreBinary computes precision and recall, and admits when it cannot", () => {
  const perfect = scoreBinary([
    { truth: true, predicted: true },
    { truth: false, predicted: false },
  ]);
  assert.equal(perfect.precision, 1);
  assert.equal(perfect.recall, 1);

  const missed = scoreBinary([
    { truth: true, predicted: false },
    { truth: false, predicted: true },
  ]);
  assert.equal(missed.precision, 0);
  assert.equal(missed.recall, 0);

  const nothingPositive = scoreBinary([{ truth: false, predicted: false }]);
  assert.equal(nothingPositive.precision, null);
  assert.equal(nothingPositive.recall, null);
});

test("scoreRun scores groups only where a prediction exists, usage everywhere", () => {
  const rows = [
    // read: true positive here.
    {
      shouldRoute: true,
      didRoute: true,
      truthGroups: new Set(["read", "shell"]),
      predictedGroups: new Set(["read"]),
    },
    // read: predicted but not used — a false positive.
    {
      shouldRoute: false,
      didRoute: true,
      truthGroups: new Set(["shell"]),
      predictedGroups: new Set(["read", "shell"]),
    },
    // read: used but not predicted — a miss, the dangerous direction.
    {
      shouldRoute: true,
      didRoute: false,
      truthGroups: new Set(["edit", "read"]),
      predictedGroups: new Set(["shell"]),
    },
    // No prediction at all: counted for usage, not for precision or recall.
    { shouldRoute: false, didRoute: false, truthGroups: new Set(["edit"]) },
  ];
  const scored = scoreRun(rows);

  assert.equal(scored.turns, 4);
  assert.equal(scored.judged, 3);

  assert.deepEqual(
    { tp: scored.groups.read.tp, fp: scored.groups.read.fp, fn: scored.groups.read.fn },
    { tp: 1, fp: 1, fn: 1 },
  );
  // shell was used in two of four turns and read in two of four.
  assert.equal(scored.groups.shell.tp, 1);
  assert.equal(scored.groups.shell.fp, 1);
  assert.equal(scored.groups.shell.fn, 1);
  assert.equal(scored.usage.shell, 2 / 4);
  assert.equal(scored.usage.read, 2 / 4);

  assert.deepEqual(
    { tp: scored.gate.tp, fp: scored.gate.fp, fn: scored.gate.fn, tn: scored.gate.tn },
    { tp: 1, fp: 1, fn: 1, tn: 1 },
  );
});

// ---------------------------------------------------------------------------
// Coverage: the metric that decides whether scoping is worth it

test("coverage counts a group as available whether it was predicted or always on", () => {
  const rows = [
    { truthGroups: new Set(["shell", "edit"]), predictedGroups: new Set() },
    { truthGroups: new Set(["web"]), predictedGroups: new Set(["web"]) },
    { truthGroups: new Set(["memory"]), predictedGroups: new Set(["read"]) },
  ];
  const report = coverageReport(rows);
  assert.equal(report.turns, 3);
  assert.equal(report.covered, 2);
  assert.ok(Math.abs(report.rate - 2 / 3) < 1e-9);
  assert.deepEqual(report.missingByGroup, { memory: 1 });
});

test("coverage names what the escape hatch is for, per group", () => {
  const rows = [
    { truthGroups: new Set(["plan"]), predictedGroups: new Set() },
    { truthGroups: new Set(["plan"]), predictedGroups: new Set() },
    { truthGroups: new Set(["skill"]), predictedGroups: new Set() },
  ];
  const report = coverageReport(rows);
  assert.deepEqual(report.missingByGroup, { plan: 2, skill: 1 });
  assert.equal(report.covered, 0);
});

test("coveredBy is about availability, not about who offered it", () => {
  const row = { truthGroups: new Set(["read", "shell"]) };
  assert.equal(coveredBy(row, new Set(["read", "shell", "web"])).covered, true);
  assert.deepEqual(coveredBy(row, new Set(["read"])).missing, ["shell"]);
});

test("the always-on set is the measured one, not a guess", () => {
  // shell 78%, edit 43%, read 38% of typed turns: predicting these would risk
  // handing a turn a toolset it cannot work with, to save schema tokens.
  assert.deepEqual(ALWAYS_ON_GROUPS, ["read", "edit", "shell"]);
  for (const group of ALWAYS_ON_GROUPS) assert.ok(!SCOPED_GROUPS.includes(group));
});

// ---------------------------------------------------------------------------
// Injected turns

test("looksInjected separates agent messages and context dumps from typed prompts", () => {
  assert.equal(looksInjected("[traycer:agent-message] from reviewer"), "agent message");
  assert.equal(looksInjected("# Workspace Directories\nYour primary..."), "context dump");
  assert.equal(looksInjected("push please"), null);
  assert.equal(looksInjected("#hashtag not a heading"), null);
});

// ---------------------------------------------------------------------------
// The battery's mapping

test("routeFromAnswers turns probabilities into a tool group set", () => {
  const routed = routeFromAnswers({
    continuation: noul(0.9),
    task_class: choice("code_change"),
    needs_files: noul(0.95),
    needs_edit: noul(0.8),
    needs_shell: noul(0.2),
    needs_web: noul(0.05),
    risk: score(1),
  });
  assert.deepEqual([...routed.groups].sort(), ["edit", "read"]);
  assert.equal(routed.taskClass, "code_change");
  assert.equal(routed.wantsStrongModel, false);
});

test("editing implies reading: a writer that cannot see the file is worse than a spare tool", () => {
  const routed = routeFromAnswers({ needs_edit: noul(0.9), needs_files: noul(0.05) });
  assert.ok(routed.groups.has("read"));
});

test("an absent judgment is not a negative one", () => {
  // The judge returning nothing usable must not read as "no tools needed".
  const routed = routeFromAnswers({});
  assert.equal(routed.groups, null);
  const nulled = routeFromAnswers({
    needs_files: { type: "noul", noul: null },
    needs_shell: { type: "score" },
  });
  assert.equal(nulled.groups, null);
});

test("thresholds sit on the boundary, not past it", () => {
  const at = routeFromAnswers({ needs_shell: noul(ROUTER_THRESHOLDS.needs) });
  assert.ok(at.groups.has("shell"));
  const below = routeFromAnswers({ needs_shell: noul(ROUTER_THRESHOLDS.needs - 0.01) });
  assert.ok(!below.groups.has("shell"));
  assert.equal(routeFromAnswers({ risk: score(ROUTER_THRESHOLDS.risk) }).wantsStrongModel, true);
});

test("an unusable task class does not invent one", () => {
  assert.equal(routeFromAnswers({ task_class: choice("invented_class") }).taskClass, null);
  assert.equal(routeFromAnswers({ task_class: { type: "choice" } }).taskClass, null);
});

test("the question set covers every group the router can scope, and no tool names", () => {
  const questions = buildQuestions();
  assert.deepEqual(Object.keys(questions).sort(), [
    "continuation",
    "needs_edit",
    "needs_files",
    "needs_shell",
    "needs_web",
    "risk",
    "task_class",
  ]);
  // Tier-1 groups those questions can predict. memory/plan/agents/skill/judge
  // have no question: they are measured for usage rate instead, and kept
  // always-on unless the data says otherwise.
  assert.ok(Object.keys(TOOL_GROUPS).includes("memory"));
});

test("buildRouterState summarises the previous turn rather than shipping it", () => {
  const state = buildRouterState({
    prompt: "push",
    previousTurn: {
      prompt: "fix the thing",
      toolCalls: [{ name: "bash" }, { name: "bash" }, { name: "edit", isError: true }],
    },
    cwd: "/repo",
    recentTools: ["bash", "read"],
  });
  assert.equal(state.prompt, "push");
  assert.deepEqual(state.previous_turn.tools_used, ["bash", "edit"]);
  assert.equal(state.previous_turn.failed_calls, 1);
  assert.equal(state.working_directory, "/repo");
  assert.equal(buildRouterState({ prompt: "x" }).previous_turn, null);
});
