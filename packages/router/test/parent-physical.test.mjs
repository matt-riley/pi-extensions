import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  ROUTER_AUTO_KEY,
  isRouterAuto,
  lastRoutedPhysicalKey,
  physicalParentKeyForCrossFamily,
} from "../parent-physical.mjs";

const luna = { provider: "openai-codex", id: "gpt-5.6-luna" };
const sol = { provider: "openai-codex", id: "gpt-5.6-sol" };

test("isRouterAuto recognises the virtual router model", () => {
  assert.equal(isRouterAuto({ provider: "router", id: "auto" }), true);
  assert.equal(isRouterAuto(luna), false);
  assert.equal(ROUTER_AUTO_KEY, "router/auto");
});

test("lastRoutedPhysicalKey walks assistant messages newest first", () => {
  const branch = [
    { type: "message", message: { role: "user", content: "hi" } },
    {
      type: "message",
      message: { role: "assistant", content: "ok", model: luna },
    },
    { type: "message", message: { role: "user", content: "harder" } },
    {
      type: "message",
      message: { role: "assistant", content: "done", model: sol },
    },
  ];
  assert.equal(lastRoutedPhysicalKey(branch), "openai-codex/gpt-5.6-sol");
});

test("physicalParentKeyForCrossFamily uses the last routed model for router/auto", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "router-parent-"));
  const file = path.join(dir, "router.json");
  fs.writeFileSync(file, JSON.stringify({ base: [{ model: "openai-codex/gpt-5.6-luna" }] }));
  const ctx = {
    model: { provider: "router", id: "auto" },
    sessionManager: {
      getBranch: () => [
        { type: "message", message: { role: "assistant", content: "x", model: sol } },
      ],
    },
    modelRegistry: { getAvailable: () => [luna, sol] },
  };
  assert.equal(physicalParentKeyForCrossFamily(ctx.model, ctx, file), "openai-codex/gpt-5.6-sol");
});

test("physicalParentKeyForCrossFamily falls back to router.json base before any route", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "router-parent-"));
  const file = path.join(dir, "router.json");
  fs.writeFileSync(file, JSON.stringify({ base: [{ model: "openai-codex/gpt-5.6-luna" }] }));
  const ctx = {
    model: { provider: "router", id: "auto" },
    sessionManager: { getBranch: () => [] },
    modelRegistry: { getAvailable: () => [luna, sol] },
  };
  assert.equal(physicalParentKeyForCrossFamily(ctx.model, ctx, file), "openai-codex/gpt-5.6-luna");
});

test("physicalParentKeyForCrossFamily returns null for a physical parent selection", () => {
  assert.equal(physicalParentKeyForCrossFamily(luna, {}, "/missing.json"), null);
});
