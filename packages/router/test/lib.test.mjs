import { test } from "node:test";
import assert from "node:assert/strict";

import {
  contentWords,
  looksInjected,
  gateTurn,
  groupOf,
  groupsUsed,
  groundTruth,
  overlapRatio,
} from "../lib.mjs";

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

test("looksInjected separates agent messages and context dumps from typed prompts", () => {
  assert.equal(looksInjected("[traycer:agent-message] from reviewer"), "agent message");
  assert.equal(looksInjected("# Workspace Directories\nYour primary..."), "context dump");
  assert.equal(looksInjected("push please"), null);
  assert.equal(looksInjected("#hashtag not a heading"), null);
});

// ---------------------------------------------------------------------------
// The battery's mapping
