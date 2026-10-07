// The model lists are a file now, so these pin the semantics that make editing
// it safe: merge per key, empty is a decision, broken narrows rather than throws.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  agentDir,
  DEFAULT_CONFIG,
  ensureRouterConfig,
  readRouterConfig,
  routerConfigPath,
} from "../config.mjs";

const tempDirs = [];

function tempFile(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "router-config-"));
  tempDirs.push(dir);
  const file = path.join(dir, "router.json");
  if (contents !== undefined) fs.writeFileSync(file, contents);
  return file;
}

after(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

test("a missing file is the built-in lists, not an error", () => {
  const loaded = readRouterConfig(tempFile());
  assert.deepEqual(loaded.base, DEFAULT_CONFIG.base);
  assert.deepEqual(loaded.frontier, DEFAULT_CONFIG.frontier);
  assert.equal(loaded.error, null);
});

test("a string and an array are both a list", () => {
  const loaded = readRouterConfig(tempFile(JSON.stringify({ base: "a/b", mid: ["c/d", "e/f"] })));
  assert.deepEqual(loaded.base, [{ model: "a/b" }]);
  assert.deepEqual(loaded.mid, [{ model: "c/d" }, { model: "e/f" }]);
  assert.deepEqual(loaded.frontier, DEFAULT_CONFIG.frontier, "missing keys keep the default");
});

test("an explicit empty list stays empty", () => {
  const loaded = readRouterConfig(tempFile(JSON.stringify({ frontier: [] })));
  assert.deepEqual(loaded.frontier, []);
  assert.equal(loaded.error, null);
});

test("broken JSON narrows to the defaults and reports why", () => {
  const loaded = readRouterConfig(tempFile("{ not json"));
  assert.deepEqual(loaded.base, DEFAULT_CONFIG.base);
  assert.match(loaded.error, /not valid JSON/);
});

test("a non-object config is rejected", () => {
  assert.match(readRouterConfig(tempFile("[1,2,3]")).error, /must be a JSON object/);
});

test("ensure writes the defaults once and never overwrites", () => {
  const file = tempFile();
  assert.equal(ensureRouterConfig(file), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), DEFAULT_CONFIG);

  fs.writeFileSync(file, JSON.stringify({ base: "custom/model" }));
  assert.equal(ensureRouterConfig(file), false);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).base, "custom/model");
});

test("the agent directory honours PI_CODING_AGENT_DIR", () => {
  assert.equal(agentDir({ PI_CODING_AGENT_DIR: "/tmp/agent-dir" }), "/tmp/agent-dir");
  assert.equal(
    routerConfigPath({ PI_CODING_AGENT_DIR: "/tmp/agent-dir" }),
    "/tmp/agent-dir/router.json",
  );
  assert.equal(routerConfigPath({}), path.join(os.homedir(), ".pi", "agent", "router.json"));
});
