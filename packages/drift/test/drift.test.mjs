import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createTracker,
  driftBetween,
  driftSection,
  isBusy,
  noteJobs,
  noteSubagent,
  takeSnapshot,
} from "../drift.mjs";

function repo(t) {
  const cwd = mkdtempSync(join(tmpdir(), "drift-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", ["-C", cwd, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "t");
  git("config", "user.email", "t@example.com");
  writeFileSync(join(cwd, "a.js"), "one\n");
  writeFileSync(join(cwd, ".gitignore"), "ignored.log\nnode_modules\n");
  git("add", ".");
  git("commit", "-qm", "base");
  return { cwd, git, write: (name, text) => writeFileSync(join(cwd, name), text) };
}

test("an unchanged tree has no drift", async (t) => {
  const r = repo(t);
  const a = await takeSnapshot(r.cwd);
  const b = await takeSnapshot(r.cwd);
  assert.equal(await driftBetween(r.cwd, a, b), null);
});

test("an edited, a new and a removed-from-dirty file are named", async (t) => {
  const r = repo(t);
  r.write("a.js", "two\n");
  r.write("scratch.txt", "x\n");
  const before = await takeSnapshot(r.cwd);
  r.write("a.js", "three\n"); // edited outside the session
  r.write("new.js", "n\n"); // created outside
  execFileSync("rm", [join(r.cwd, "scratch.txt")]); // deleted outside
  const after = await takeSnapshot(r.cwd);
  const drift = await driftBetween(r.cwd, before, after);
  assert.deepEqual(drift.files, ["a.js", "new.js", "scratch.txt"]);
  assert.equal(drift.headMoved, null);
});

test("ignored files, node_modules and the code-search cache are not drift", async (t) => {
  const r = repo(t);
  const before = await takeSnapshot(r.cwd);
  r.write("ignored.log", "noise\n");
  mkdirSync(join(r.cwd, "node_modules", "x"), { recursive: true });
  r.write("node_modules/x/i.js", "dep\n");
  mkdirSync(join(r.cwd, ".pi", "cache"), { recursive: true });
  r.write(".pi/cache/pi-code-search.json", "{}\n");
  const after = await takeSnapshot(r.cwd);
  assert.equal(await driftBetween(r.cwd, before, after), null);
});

test("a commit or checkout outside the session reports HEAD and the files it moved", async (t) => {
  const r = repo(t);
  const before = await takeSnapshot(r.cwd);
  r.write("b.js", "b\n");
  r.git("add", ".");
  r.git("commit", "-qm", "outside");
  const after = await takeSnapshot(r.cwd);
  const drift = await driftBetween(r.cwd, before, after);
  assert.deepEqual(drift.files, ["b.js"]);
  assert.equal(drift.headMoved.from, before.head);
  assert.equal(drift.headMoved.to, after.head);
});

test("a directory that is not a git repo has no snapshot", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "drift-nogit-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  assert.equal(await takeSnapshot(cwd), null);
});

test("many changed files are capped with a count of the rest", () => {
  const files = Array.from({ length: 30 }, (_, i) => `f${String(i).padStart(2, "0")}.js`);
  const text = driftSection({ files, headMoved: null });
  assert.match(text, /f00\.js/);
  assert.doesNotMatch(text, /f29\.js/);
  assert.match(text, /and \d+ more/);
});

test("the section names the files, the head move, and says to re-read", () => {
  const text = driftSection({
    files: ["src/a.ts"],
    headMoved: { from: "abc1234567", to: "def7654321" },
  });
  assert.match(text, /src\/a\.ts/);
  assert.match(text, /abc1234/);
  assert.match(text, /def7654/);
  assert.match(text, /re-read/i);
  assert.ok(text.length < 1200);
});

test("own subagents and jobs make the tracker busy, and finishing frees it", () => {
  const tracker = createTracker();
  assert.equal(isBusy(tracker), false);
  noteSubagent(tracker, "subagents:started", { id: "worker" });
  assert.equal(isBusy(tracker), true);
  noteSubagent(tracker, "subagents:completed", { id: "worker" });
  assert.equal(isBusy(tracker), false);

  noteSubagent(tracker, "subagents:started", { id: "w2" });
  noteSubagent(tracker, "subagents:stopped", { id: "w2" });
  assert.equal(isBusy(tracker), false);
  noteSubagent(tracker, "subagents:started", { id: "w3" });
  noteSubagent(tracker, "subagents:failed", { id: "w3" });
  assert.equal(isBusy(tracker), false);

  noteJobs(tracker, {
    toolName: "terminal_start",
    details: { job: { id: "j1", status: "running" } },
  });
  assert.equal(isBusy(tracker), true);
  noteJobs(tracker, {
    toolName: "terminal_read",
    details: { job: { id: "j1", status: "exited" } },
  });
  assert.equal(isBusy(tracker), false);
  noteJobs(tracker, { toolName: "bash", details: { job: { id: "j2", status: "running" } } });
  assert.equal(isBusy(tracker), false, "only terminal_* results are job signals");
  noteJobs(tracker, { toolName: "terminal_start", details: {} });
  assert.equal(isBusy(tracker), false);
});
