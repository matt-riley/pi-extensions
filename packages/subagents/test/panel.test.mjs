import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pickJudge, pickPanel, readRoles, resolvePanel } from "../cross-family.mjs";

const m = (provider, id) => ({ provider, id });
const available = [
  m("anthropic", "claude-fable-5-2"),
  m("anthropic", "claude-opus-5-5"),
  m("google", "gemini-4-carbon"),
  m("openai-codex", "gpt-5.6-sol"),
  m("xai", "grok-4.6"),
];

test("pickPanel seats one model per vendor: Fable and Opus are one seat", () => {
  const { seats, notes } = pickPanel(available, [], {
    preferred: ["claude-fable-5-2", "claude-opus-5-5", "gemini-4-carbon"],
  });
  assert.deepEqual(seats, ["anthropic/claude-fable-5-2", "google/gemini-4-carbon"]);
  assert.deepEqual(notes, [
    "roles.panel: anthropic/claude-opus-5-5 skipped, anthropic already has a seat (one seat per vendor)",
  ]);
});

test("pickPanel fills from the tiers in order and stops at size", () => {
  const { seats } = pickPanel(available, [
    "gpt-5.6-sol",
    "claude-opus-5-5",
    "gpt-5.6-luna",
    "grok",
  ]);
  assert.deepEqual(seats, [
    "openai-codex/gpt-5.6-sol",
    "anthropic/claude-opus-5-5",
    "xai/grok-4.6",
  ]);
  assert.equal(
    pickPanel(available, ["gpt", "claude", "gemini", "grok"], { size: 2 }).seats.length,
    2,
  );
});

test("pickPanel skips unauthenticated and unknown-vendor entries, and says so for roles", () => {
  const { seats, notes } = pickPanel([...available, m("acme", "mystery-1")], ["claude"], {
    preferred: ["deepseek-v9", "mystery-1"],
  });
  assert.deepEqual(seats, ["anthropic/claude-fable-5-2"]);
  assert.deepEqual(notes, [
    "roles.panel: deepseek-v9 is not authenticated; skipped",
    "roles.panel: acme/mystery-1 skipped, its vendor is unknown",
  ]);
});

test("pickJudge takes the first pool entry outside the parent's vendor", () => {
  const parent = m("anthropic", "claude-opus-5-5");
  assert.equal(
    pickJudge(parent, available, ["claude-fable-5-2", "gemini-4-carbon"]),
    "google/gemini-4-carbon",
  );
  assert.equal(pickJudge(parent, available, ["claude-fable-5-2"]), undefined);
  assert.equal(pickJudge(m("router", "auto"), available, ["gemini"]), undefined);
  assert.equal(
    pickJudge(m("router", "auto"), available, ["gpt", "gemini"], {
      physicalParentKey: "openai-codex/gpt-5.6-sol",
    }),
    "google/gemini-4-carbon",
  );
});

test("resolvePanel reads roles, falls back to tiers, and reports a one-vendor panel", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "panel-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "router.json");
  const parent = m("openai-codex", "gpt-5.6-sol");
  const registry = { getAvailable: async () => available };

  fs.writeFileSync(
    file,
    JSON.stringify({
      frontier: ["grok-4.6"],
      roles: { panel: ["claude-opus-5-5", "gemini-4-carbon"], judge: ["gpt-5.6", "gemini"] },
    }),
  );
  assert.deepEqual(await resolvePanel(registry, parent, file), {
    seats: ["anthropic/claude-opus-5-5", "google/gemini-4-carbon", "xai/grok-4.6"],
    judge: "google/gemini-4-carbon",
    notes: [],
  });

  fs.writeFileSync(file, JSON.stringify({ frontier: ["claude-opus-5-5", "claude-fable-5-2"] }));
  const lonely = await resolvePanel(registry, parent, file);
  assert.deepEqual(lonely.seats, ["anthropic/claude-opus-5-5"]);
  assert.equal(lonely.judge, "anthropic/claude-opus-5-5");
  assert.match(lonely.notes.join("\n"), /panel has 1 vendor: that repeats one set of blind spots/);

  const none = await resolvePanel({ getAvailable: () => [] }, parent, path.join(dir, "missing"));
  assert.deepEqual(none.seats, []);
  assert.equal(none.judge, undefined);
  assert.match(none.notes.join("\n"), /no authenticated judge outside the parent's vendor/);
  assert.deepEqual(readRoles(path.join(dir, "missing")), { panel: [], judge: [] });
});
