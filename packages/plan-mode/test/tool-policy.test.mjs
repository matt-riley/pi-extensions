import assert from "node:assert/strict";
import test from "node:test";

import {
  LOCAL_DESTRUCTIVE,
  LOCAL_READ,
  OPEN_DESTRUCTIVE,
  OPEN_READ,
} from "../../../shared/tool-annotations.mjs";
import { planToolVerdict, selectPlanTools } from "../tool-policy.mjs";

function info(name, annotations, exposure) {
  return { name, annotations, exposure };
}

const HISTORICAL = [
  "read",
  "bash",
  "grep",
  "find",
  "ls",
  "repo_map",
  "code_search",
  "file_outline",
  "find_definition",
  "skill_select",
  "lore_recall",
  "plan_mode_question",
  "plan_mode_complete",
  "plan_fetch_url",
  "web_search",
];

test("local readers are allowed", () => {
  assert.equal(planToolVerdict("code_search", info("code_search", LOCAL_READ)), "allow");
  assert.equal(planToolVerdict("skill_select", info("skill_select", LOCAL_READ)), "allow");
  assert.equal(planToolVerdict("view_context", info("view_context", LOCAL_READ)), "allow");
});

test("open-world readers stay out except web_search and plan-owned tools", () => {
  assert.equal(planToolVerdict("web_fetch", info("web_fetch", OPEN_READ)), "block");
  assert.equal(planToolVerdict("typesafe_ask", info("typesafe_ask", OPEN_READ)), "block");
  assert.equal(planToolVerdict("read_relevant", info("read_relevant", OPEN_READ)), "block");
  assert.equal(planToolVerdict("web_search", info("web_search", OPEN_READ)), "allow");
  assert.equal(
    planToolVerdict("plan_fetch_url", info("plan_fetch_url", OPEN_READ, "deferred")),
    "allow",
  );
  assert.equal(
    planToolVerdict("plan_mode_question", info("plan_mode_question", OPEN_READ, "deferred")),
    "allow",
  );
});

test("writers are blocked except the plan file tool", () => {
  assert.equal(planToolVerdict("self_compact", info("self_compact", LOCAL_DESTRUCTIVE)), "block");
  assert.equal(planToolVerdict("subagent", info("subagent", OPEN_DESTRUCTIVE)), "block");
  assert.equal(
    planToolVerdict("influencer_save", info("influencer_save", LOCAL_DESTRUCTIVE, "deferred")),
    "block",
  );
  assert.equal(
    planToolVerdict("plan_mode_complete", info("plan_mode_complete", OPEN_DESTRUCTIVE, "deferred")),
    "allow",
  );
});

test("deferred readers other than plan mode's own tools stay out", () => {
  assert.equal(
    planToolVerdict("influencer_show", info("influencer_show", LOCAL_READ, "deferred")),
    "block",
  );
  assert.equal(planToolVerdict("lint_change", info("lint_change", OPEN_READ, "deferred")), "block");
  assert.equal(planToolVerdict("web_answer", info("web_answer", OPEN_READ, "deferred")), "block");
  assert.equal(
    planToolVerdict("batch_web_fetch", info("batch_web_fetch", OPEN_READ, "deferred")),
    "block",
  );
});

test("unannotated tools keep today's external allowlist", () => {
  for (const name of ["read", "grep", "find", "ls", "lore_recall"]) {
    assert.equal(planToolVerdict(name), "allow", name);
  }
  assert.equal(planToolVerdict("bash"), "bash");
  for (const name of ["edit", "write", "glob", "get_transcript", "update_plan"]) {
    assert.equal(planToolVerdict(name), "block", name);
  }
});

test("an explicit hint overrides the external name", () => {
  assert.equal(planToolVerdict("read", info("read", LOCAL_DESTRUCTIVE)), "block");
  assert.equal(planToolVerdict("edit", info("edit", LOCAL_READ)), "allow");
});

test("a registry failure keeps the historical plan set", () => {
  assert.equal(planToolVerdict("code_search", undefined, { registryUnavailable: true }), "allow");
  assert.equal(planToolVerdict("web_fetch", undefined, { registryUnavailable: true }), "block");
  assert.equal(planToolVerdict("view_context", undefined, { registryUnavailable: true }), "block");
  assert.equal(planToolVerdict("bash", undefined, { registryUnavailable: true }), "bash");
  assert.deepEqual(selectPlanTools(undefined), HISTORICAL);
});

test("selectPlanTools follows annotations", () => {
  const registered = [
    info("plan_mode_question", OPEN_READ, "deferred"),
    info("plan_mode_complete", OPEN_DESTRUCTIVE, "deferred"),
    info("plan_fetch_url", OPEN_READ, "deferred"),
    info("web_fetch", OPEN_READ),
    info("web_answer", OPEN_READ, "deferred"),
    info("batch_web_fetch", OPEN_READ, "deferred"),
    info("web_search", OPEN_READ),
    info("repo_map", LOCAL_READ),
    info("code_search", LOCAL_READ),
    info("file_outline", LOCAL_READ),
    info("find_definition", LOCAL_READ),
    info("view_context", LOCAL_READ),
    info("self_compact", LOCAL_DESTRUCTIVE),
    info("typesafe_ask", OPEN_READ),
    info("read_relevant", OPEN_READ),
    info("skill_select", LOCAL_READ),
    info("influencer_show", LOCAL_READ, "deferred"),
    info("subagent", OPEN_DESTRUCTIVE),
    info("lint_change", OPEN_READ, "deferred"),
    info("verify_findings", OPEN_READ, "deferred"),
    { name: "read" },
    { name: "bash" },
  ];
  const names = selectPlanTools(registered);
  for (const name of [
    "read",
    "bash",
    "grep",
    "find",
    "ls",
    "lore_recall",
    "repo_map",
    "code_search",
    "file_outline",
    "find_definition",
    "skill_select",
    "view_context",
    "web_search",
    "plan_mode_question",
    "plan_mode_complete",
    "plan_fetch_url",
  ]) {
    assert.ok(names.includes(name), name);
  }
  for (const name of [
    "web_fetch",
    "web_answer",
    "batch_web_fetch",
    "typesafe_ask",
    "read_relevant",
    "self_compact",
    "influencer_show",
    "subagent",
    "lint_change",
    "verify_findings",
    "edit",
    "write",
  ]) {
    assert.equal(names.includes(name), false, name);
  }
});
