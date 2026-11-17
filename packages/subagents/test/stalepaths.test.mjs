import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { findStalePaths } from "../../../shared/stalepaths.mjs";
import { preflightTask } from "../judge.mjs";

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stale-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "loader.mjs"), "");
  fs.writeFileSync(path.join(root, ".github", "workflows", "ci.yml"), "");
  return root;
}

test("existing paths are not stale", () => {
  const root = repo();
  const task = "Read src/loader.mjs and `.github/workflows/ci.yml:12` then report.";
  assert.deepEqual(findStalePaths(task, root), []);
});

test("a path that no longer exists is reported once, as written", () => {
  const root = repo();
  const task = "Trace src/old-loader.mjs and src/old-loader.mjs:40, then src/loader.mjs.";
  assert.deepEqual(findStalePaths(task, root), ["src/old-loader.mjs"]);
});

test("URLs, domains, bare words and globs are ignored", () => {
  const root = repo();
  const task =
    "See https://github.com/org/repo/blob/main/README.md and github.com/org/repo.git; " +
    "use and/or, 24/7, src/*.mjs, and src/ as scope.";
  assert.deepEqual(findStalePaths(task, root), []);
});

test("a path the task says to create is not stale", () => {
  const root = repo();
  assert.deepEqual(findStalePaths("Create src/new-helper.mjs with one export.", root), []);
  assert.deepEqual(findStalePaths("Add a test at test/new.test.mjs.", root), []);
  assert.deepEqual(findStalePaths("Create src/a.mjs.\nThen read src/gone.mjs.", root), [
    "src/gone.mjs",
  ]);
});

test("absolute paths are checked as written", () => {
  const root = repo();
  assert.deepEqual(findStalePaths("Read /nonexistent-dir/file.txt", root), [
    "/nonexistent-dir/file.txt",
  ]);
  assert.deepEqual(findStalePaths(`Read ${path.join(root, "src/loader.mjs")}`, root), []);
});

test("at most eight stale paths are listed", () => {
  const root = repo();
  const task = Array.from({ length: 12 }, (_, i) => `src/gone${i}.mjs`).join(" ");
  assert.equal(findStalePaths(task, root).length, 8);
});

test("preflightTask blocks a task naming stale paths once, before asking a model", async () => {
  const root = repo();
  let asked = 0;
  const askImpl = async () => {
    asked += 1;
    return { answers: {} };
  };
  const args = {
    agent: "scout",
    task: "Review src/old-loader.mjs for retries.",
    cwd: root,
    writeCapable: false,
    askImpl,
  };
  const blocked = await preflightTask(args);
  assert.match(blocked.reject, /src\/old-loader\.mjs/);
  assert.match(blocked.reject, /does not exist/);
  assert.equal(asked, 0);
  // An identical resubmission is trusted, like every other preflight rejection.
  assert.equal((await preflightTask(args)).reject, undefined);
});

test("preflightTask without a cwd skips the path check", async () => {
  const out = await preflightTask({
    agent: "scout",
    task: "Review src/old-loader.mjs for retries.",
    writeCapable: false,
    askImpl: async () => ({ answers: {} }),
  });
  assert.equal(out.reject, undefined);
});
