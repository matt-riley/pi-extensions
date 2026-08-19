import { test } from "node:test";
import assert from "node:assert/strict";
import { reconcileActiveTools, resolveChildModel } from "../policy.mjs";

test("reconcileActiveTools adds, removes, and no-ops", () => {
  const base = ["read", "bash"];
  assert.deepEqual(reconcileActiveTools(base, true, "subagent"), ["read", "bash", "subagent"]);
  assert.deepEqual(reconcileActiveTools(base, false, "subagent"), base);
  assert.deepEqual(reconcileActiveTools(["read", "subagent"], false, "subagent"), ["read"]);
  assert.equal(reconcileActiveTools(base, false, "subagent"), base); // unchanged → same ref
  assert.deepEqual(reconcileActiveTools(undefined, true, "subagent"), ["subagent"]);
});

test("resolveChildModel inherits the parent or pins a provider/id", () => {
  const parent = { id: "parent-model" };
  assert.deepEqual(resolveChildModel(undefined, parent, undefined), { model: parent, note: undefined });
  assert.deepEqual(resolveChildModel(undefined, parent, "sonnet"), {
    model: parent,
    note: 'unresolved model "sonnet"; inherited parent',
  });

  const registry = {
    getModel: (provider, id) => (id === "claude-sonnet-4-5" ? { provider, id } : undefined),
  };
  assert.deepEqual(resolveChildModel(registry, parent, "anthropic/claude-sonnet-4-5"), {
    model: { provider: "anthropic", id: "claude-sonnet-4-5" },
    note: undefined,
  });

  const missing = resolveChildModel(registry, parent, "openai/nope");
  assert.equal(missing.model, parent);
  assert.match(missing.note, /unresolved model "openai\/nope"/);
});
