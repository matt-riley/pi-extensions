import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_SETTINGS, loadSettings, sanitizeSettings } from "../settings.mjs";

function tmpSettings(files) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "web-fetch-settings-"));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), JSON.stringify(content));
  }
  return dir;
}

test("defaults when no settings files exist", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "web-fetch-empty-"));
  try {
    const s = await loadSettings({ cwd: dir, globalPath: path.join(dir, "missing.json"), projectPath: path.join(dir, "missing2.json") });
    assert.equal(s.defaultFormat, "markdown");
    assert.equal(s.defaultMaxChars, 60000);
    assert.equal(s.batchConcurrency, 4);
    assert.equal(s.useGh, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project overrides global, nested and flat keys both work", async () => {
  const dir = tmpSettings({
    "global.json": { webFetch: { defaultMaxChars: 1000, defaultFormat: "text" } },
    "project.json": { webFetchDefaultFormat: "json" },
  });
  try {
    const s = await loadSettings({
      cwd: dir,
      globalPath: path.join(dir, "global.json"),
      projectPath: path.join(dir, "project.json"),
    });
    assert.equal(s.defaultMaxChars, 1000); // from global
    assert.equal(s.defaultFormat, "json"); // project flat key wins
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sanitizeSettings: clamps and coerces", () => {
  const s = sanitizeSettings({
    webFetchDefaultMaxChars: "99999999", // clamps to 1_000_000
    webFetchDefaultTimeoutMs: 50,        // clamps to 1000
    webFetchBatchConcurrency: 100,       // clamps to 10
    webFetchDefaultFormat: "bogus",      // ignored
    webFetchIncludeImages: "true",       // string bool accepted
    webFetchUseGh: false,
    webFetchExtraHeaders: { "x-a": 1, "x-b": "y" },
  });
  assert.equal(s.defaultMaxChars, 1_000_000);
  assert.equal(s.defaultTimeoutMs, 1000);
  assert.equal(s.batchConcurrency, 10);
  assert.equal(s.defaultFormat, undefined); // invalid format dropped
  assert.equal(s.includeImages, true);
  assert.equal(s.useGh, false);
  assert.deepEqual(s.extraHeaders, { "x-a": "1", "x-b": "y" });
});

test("sanitizeSettings: broken input ignored", () => {
  assert.deepEqual(sanitizeSettings(null), {});
  assert.deepEqual(sanitizeSettings({ webFetchDefaultMaxChars: "abc" }), {});
  assert.deepEqual(sanitizeSettings({ webFetchExtraHeaders: "nope" }), {});
});

test("defaults survive sanitize", () => {
  const s = sanitizeSettings({});
  assert.deepEqual(s, {});
  const merged = { ...DEFAULT_SETTINGS, ...s };
  assert.equal(merged.defaultFormat, "markdown");
});
