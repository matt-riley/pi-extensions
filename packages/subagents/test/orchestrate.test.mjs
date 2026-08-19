import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAgentRoster, orchestratorPrompt, withOrchestratorPrompt } from "../orchestrate.mjs";

test("formatAgentRoster lists names and descriptions", () => {
  assert.equal(formatAgentRoster([]), "none");
  assert.equal(
    formatAgentRoster([
      { name: "scout", description: "Fast recon" },
      { name: "reviewer" },
    ]),
    "- scout — Fast recon\n- reviewer",
  );
});

test("orchestratorPrompt names the main thread and the roster", () => {
  const text = orchestratorPrompt([{ name: "scout", description: "Fast recon" }]);
  assert.match(text, /main thread/);
  assert.match(text, /control creation/i);
  assert.match(text, /- scout — Fast recon/);
  assert.match(text, /Children never spawn children/);
});

test("withOrchestratorPrompt appends once", () => {
  const first = withOrchestratorPrompt("base", [{ name: "oracle" }]);
  assert.ok(first.startsWith("base\n\n# Orchestrator"));
  const second = withOrchestratorPrompt(first, [{ name: "oracle" }]);
  assert.equal(second, first);
});
