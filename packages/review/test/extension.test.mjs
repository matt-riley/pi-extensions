import assert from "node:assert/strict";
import test from "node:test";

import {
  createToolRegistry,
  initialActiveToolNames,
  isActivatedOnRegistration,
  searchAndLoad,
} from "../../../shared/tool-search.mjs";
import extension from "../index.ts";

function loadTools() {
  const tools = [];
  extension({
    registerTool: (def) => tools.push(def),
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    on: () => {},
  });
  return tools;
}

const DEFERRED_REVIEW = ["lint_change", "verify_findings"];

for (const name of DEFERRED_REVIEW) {
  test(`${name} stays out of the initial tool list`, () => {
    const tools = loadTools();
    const def = tools.find((tool) => tool.name === name);
    assert.ok(def, `${name} registered`);
    assert.equal(isActivatedOnRegistration(def), false, `${name} should be deferred`);
    const initial = initialActiveToolNames(tools);
    assert.equal(initial.includes(name), false);
  });

  test(`${name} is reachable through tool search`, () => {
    const tools = loadTools();
    const registry = createToolRegistry(tools);
    const query =
      name === "lint_change" ? "lint_change staged diff preferences" : "verify_findings review findings diff";
    const matches = searchAndLoad(registry, query, 8);
    assert.ok(
      matches.some((match) => match.name === name),
      `search did not load ${name}: ${JSON.stringify(matches)}`,
    );
    assert.ok(registry.getActiveTools().includes(name));
  });
}
