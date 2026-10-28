import assert from "node:assert/strict";
import test from "node:test";

import {
  Bm25Ranker,
  createToolSearchDocument,
  isSearchableExposure,
  searchAndLoad,
  toolExposure,
  tokenize,
} from "../shared/tool-search.mjs";

test("tokenize splits deferred tool names for search", () => {
  assert.ok(tokenize("batch_web_fetch").includes("batch"));
  assert.ok(tokenize("web_answer").includes("answer"));
});

test("toolExposure defaults to direct and defers searchable tools", () => {
  assert.equal(toolExposure({}), "direct");
  assert.equal(isSearchableExposure("deferred"), true);
  assert.equal(isSearchableExposure("direct"), false);
});

test("createToolSearchDocument indexes names and schema fields", () => {
  const document = createToolSearchDocument({
    name: "lint_change",
    description: "semantic lint",
    parameters: { properties: { scope: { description: "staged diff scope" } } },
  });
  assert.match(document.text, /lint_change/);
  assert.match(document.text, /scope/);
});

test("searchAndLoad ranks an exact tool name first among deferred tools", () => {
  const registry = {
    active: ["read"],
    getActiveTools() {
      return this.active;
    },
    getAllTools() {
      return [
        { name: "lint_change", exposure: "deferred", description: "semantic lint" },
        { name: "verify_findings", exposure: "deferred", description: "verify review" },
      ];
    },
    setActiveTools(names) {
      this.active = names;
    },
  };
  const matches = searchAndLoad(registry, "lint_change", 3);
  assert.deepEqual(
    matches.map((match) => match.name),
    ["lint_change"],
  );
  assert.deepEqual(registry.getActiveTools(), ["read", "lint_change"]);
});

test("Bm25Ranker returns no matches for an empty query", () => {
  assert.deepEqual(
    new Bm25Ranker().rank("", [{ name: "lint_change", text: "lint_change semantic" }], 3),
    [],
  );
});
