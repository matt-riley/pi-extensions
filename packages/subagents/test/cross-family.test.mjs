import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  modelFamily,
  pickCrossFamily,
  readPatterns,
  resolveCrossFamily,
} from "../cross-family.mjs";

const m = (provider, id) => ({ provider, id });

test("modelFamily groups by model id, not provider", () => {
  assert.equal(modelFamily("openai-codex/gpt-5.6-sol"), "openai");
  assert.equal(modelFamily("openai/gpt-5.6-sol"), "openai");
  assert.equal(modelFamily("openrouter/anthropic/claude-opus-5-5"), "anthropic");
  assert.equal(modelFamily("xai/grok-4.6"), "xai");
  assert.equal(modelFamily("deepseek/deepseek-flash"), "deepseek");
  assert.equal(modelFamily("router/auto"), null);
  assert.equal(modelFamily("acme/mystery"), null);
});

test("pickCrossFamily takes the first pattern served by another family", () => {
  const parent = m("openai-codex", "gpt-5.6-luna");
  const available = [
    parent,
    m("openai-codex", "gpt-5.6-sol"),
    m("xai", "grok-4.6"),
    m("moonshot", "kimi-k3"),
  ];
  const patterns = ["openai-codex/gpt-5.6-sol", "grok-4.6", "kimi-k3"];
  const { model, note } = pickCrossFamily(parent, available, patterns);
  assert.deepEqual(model, m("xai", "grok-4.6"));
  assert.match(note, /xai\/grok-4.6/);
});

test("pickCrossFamily inherits when nothing outside the parent family is available", () => {
  const parent = m("deepseek", "deepseek-flash");
  const result = pickCrossFamily(
    parent,
    [parent, m("deepseek", "deepseek-pro")],
    ["deepseek-pro", "grok-4.6"],
  );
  assert.equal(result.model, parent);
  assert.match(result.note, /inherited parent/);
});

test("pickCrossFamily inherits when the parent family is unknown", () => {
  const parent = m("router", "auto");
  const result = pickCrossFamily(parent, [m("xai", "grok-4.6")], ["grok-4.6"]);
  assert.equal(result.model, parent);
  assert.match(result.note, /parent family unknown/);
});

test("readPatterns orders frontier, mid, base and tolerates a missing file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xfam-"));
  const file = path.join(dir, "router.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      base: ["a"],
      mid: [{ model: "b", thinking: "high" }],
      frontier: [{ model: "c" }, "a"],
    }),
  );
  assert.deepEqual(readPatterns(file), ["c", "a", "b"]);
  assert.deepEqual(readPatterns(path.join(dir, "missing.json")), []);
});

test("resolveCrossFamily uses only authenticated models from the registry", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xfam-"));
  const file = path.join(dir, "router.json");
  fs.writeFileSync(file, JSON.stringify({ frontier: ["claude-opus-5-5", "grok-4.6"] }));
  const parent = m("openai-codex", "gpt-5.6-sol");
  const registry = { getAvailable: async () => [parent, m("xai", "grok-4.6")] };
  const { model } = await resolveCrossFamily(registry, parent, file);
  assert.deepEqual(model, m("xai", "grok-4.6"));
  const broken = {
    getAvailable: () => {
      throw new Error("offline");
    },
  };
  assert.equal((await resolveCrossFamily(broken, parent, file)).model, parent);
});
