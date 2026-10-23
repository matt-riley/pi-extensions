import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";

import {
  LOCAL_DESTRUCTIVE,
  LOCAL_READ,
  OPEN_DESTRUCTIVE,
  OPEN_READ,
} from "../shared/tool-annotations.mjs";
import { loadRegistrations } from "./registration.mjs";

// exposure "deferred" is the rare-tool set. Plan-mode tools are activated by
// the mode; influencer tools by /influencer. Everything else stays direct:
// Pi registers tool_search inactive, so a deferred tool with no activator
// would leave the prompt along with the guideline that tells the model to
// use it. A tool missing from this map fails the check.
const EXPECTED = new Map([
  ["repo_map", { annotations: LOCAL_READ, deferred: false }],
  ["code_search", { annotations: LOCAL_READ, deferred: false }],
  ["file_outline", { annotations: LOCAL_READ, deferred: false }],
  ["find_definition", { annotations: LOCAL_READ, deferred: false }],
  ["skill_select", { annotations: LOCAL_READ, deferred: false }],
  ["view_context", { annotations: LOCAL_READ, deferred: false }],
  ["web_fetch", { annotations: OPEN_READ, deferred: false }],
  ["web_search", { annotations: OPEN_READ, deferred: false }],
  ["typesafe_ask", { annotations: OPEN_READ, deferred: false }],
  ["read_relevant", { annotations: OPEN_READ, deferred: false }],
  ["self_compact", { annotations: LOCAL_DESTRUCTIVE, deferred: false }],
  ["subagent", { annotations: OPEN_DESTRUCTIVE, deferred: false }],
  ["web_answer", { annotations: OPEN_READ, deferred: false }],
  ["batch_web_fetch", { annotations: OPEN_READ, deferred: false }],
  ["lint_change", { annotations: OPEN_READ, deferred: false }],
  ["verify_findings", { annotations: OPEN_READ, deferred: false }],
  ["plan_mode_question", { annotations: OPEN_READ, deferred: true }],
  ["plan_fetch_url", { annotations: OPEN_READ, deferred: true }],
  ["plan_mode_complete", { annotations: OPEN_DESTRUCTIVE, deferred: true }],
  ["influencer_save", { annotations: LOCAL_DESTRUCTIVE, deferred: true }],
  ["influencer_show", { annotations: LOCAL_READ, deferred: true }],
  ["influencer_list", { annotations: LOCAL_READ, deferred: true }],
  ["influencer_prompt", { annotations: LOCAL_READ, deferred: true }],
]);

test("every tool declares annotations and only rare tools are deferred", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const { results, tools } = await loadRegistrations(root);
  const failed = results.filter((result) => !result.ok);
  assert.deepEqual(
    failed.map((result) => `${result.name}: ${result.detail}`),
    [],
  );
  assert.equal(tools.length, EXPECTED.size, tools.map((tool) => tool.name).join(", "));

  const seen = new Set();
  for (const tool of tools) {
    const expected = EXPECTED.get(tool.name);
    assert.ok(expected, `${tool.name} is missing annotations coverage`);
    assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", tool.name);
    assert.equal(typeof tool.annotations?.destructiveHint, "boolean", tool.name);
    assert.equal(typeof tool.annotations?.openWorldHint, "boolean", tool.name);
    assert.deepEqual(tool.annotations, expected.annotations, tool.name);
    assert.equal(tool.exposure === "deferred", expected.deferred, tool.name);
    if (tool.annotations.readOnlyHint) {
      assert.equal(tool.annotations.destructiveHint, false, tool.name);
    }
    seen.add(tool.name);
  }
  for (const name of EXPECTED.keys()) {
    assert.ok(seen.has(name), `${name} was not registered`);
  }
});
