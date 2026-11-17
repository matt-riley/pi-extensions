import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWorktrees, worktreeLine } from "../worktree.mjs";
import { createPool } from "../pool.mjs";

const git = (cwd, ...args) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), "subagent-wt-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo");
  const agentDir = path.join(dir, "agent");
  mkdirSync(path.join(repo, "src"), { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  writeFileSync(path.join(repo, "tracked.txt"), "one\n");
  writeFileSync(path.join(repo, "staged.txt"), "a\n");
  writeFileSync(path.join(repo, "src", "keep.txt"), "k\n");
  writeFileSync(path.join(repo, ".gitignore"), "ignored.txt\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  return { dir, repo, agentDir };
}

test("create copies staged, unstaged and untracked changes but not ignored files", async (t) => {
  const { repo, agentDir } = fixture(t);
  writeFileSync(path.join(repo, "tracked.txt"), "one\ntwo\n");
  writeFileSync(path.join(repo, "staged.txt"), "a\nb\n");
  git(repo, "add", "staged.txt");
  writeFileSync(path.join(repo, "src", "new.txt"), "fresh\n");
  writeFileSync(path.join(repo, "ignored.txt"), "secret\n");
  const worktrees = createWorktrees({ agentDir });

  const wt = await worktrees.create(path.join(repo, "src"), "worker");

  assert.ok(wt.path.startsWith(path.join(agentDir, "subagent-worktrees")), wt.path);
  assert.ok(!wt.path.startsWith(repo), "never inside the repository");
  assert.match(wt.branch, /^pi-subagent\/worker-[0-9a-f]{6}$/);
  assert.equal(wt.cwd, path.join(wt.path, "src"), "the parent's subdirectory maps across");
  assert.equal(readFileSync(path.join(wt.path, "tracked.txt"), "utf8"), "one\ntwo\n");
  assert.equal(readFileSync(path.join(wt.path, "staged.txt"), "utf8"), "a\nb\n");
  assert.equal(readFileSync(path.join(wt.path, "src", "new.txt"), "utf8"), "fresh\n");
  assert.equal(existsSync(path.join(wt.path, "ignored.txt")), false);
  assert.equal(git(repo, "status", "--porcelain").includes("src/new.txt"), true, "parent intact");

  const left = await worktrees.describe(wt);
  assert.deepEqual(
    { commits: left.commits, changed: left.changed, known: left.known },
    { commits: 0, changed: false, known: true },
    "copied changes are the starting point, not the child's work",
  );
});

test("describe and removeIfEmpty keep a worktree with a dirty file or a commit", async (t) => {
  const { repo, agentDir } = fixture(t);
  writeFileSync(path.join(repo, "tracked.txt"), "parent edit\n");
  const worktrees = createWorktrees({ agentDir });

  const dirty = await worktrees.create(repo, "worker");
  writeFileSync(path.join(dirty.path, "child.txt"), "made by the child\n");
  const left = await worktrees.describe(dirty);
  assert.equal(left.changed, true);
  assert.match(left.stat, /child\.txt/);
  assert.doesNotMatch(left.stat, /tracked\.txt/, "the parent's copied edit is not the child's");
  assert.match(left.diff, /\+made by the child/);
  assert.equal(await worktrees.removeIfEmpty(dirty), false);
  assert.equal(existsSync(dirty.path), true);

  const committed = await worktrees.create(repo, "worker");
  git(committed.path, "add", "-A");
  git(committed.path, "commit", "-q", "-m", "child commit");
  writeFileSync(path.join(committed.path, "tracked.txt"), "parent edit\n");
  assert.equal((await worktrees.describe(committed)).commits, 1);
  assert.equal(await worktrees.removeIfEmpty(committed), false);

  const kept = await worktrees.listKept(repo);
  assert.deepEqual(kept.map((item) => item.branch).sort(), [dirty.branch, committed.branch].sort());
  assert.match(worktreeLine(dirty, left), /0 commits, changed\)/);
});

test("removeIfEmpty removes an untouched worktree and its branch", async (t) => {
  const { repo, agentDir } = fixture(t);
  writeFileSync(path.join(repo, "untracked.txt"), "copied\n");
  const worktrees = createWorktrees({ agentDir });
  const wt = await worktrees.create(repo, "oracle");

  assert.equal(await worktrees.removeIfEmpty(wt), true);
  assert.equal(existsSync(wt.path), false);
  assert.equal(git(repo, "branch", "--list", wt.branch).trim(), "");
  assert.deepEqual(await worktrees.listKept(repo), []);
});

test("a failed git apply is an error and leaves no worktree behind", async (t) => {
  const { repo, agentDir } = fixture(t);
  writeFileSync(path.join(repo, "tracked.txt"), "dirty\n");
  const calls = [];
  const exec = (args, opts) =>
    new Promise((resolve) => {
      calls.push(args[0]);
      if (args[0] === "apply")
        return resolve({ code: 1, stdout: "", stderr: "patch does not apply" });
      try {
        resolve({ code: 0, stdout: git(opts.cwd, ...args), stderr: "" });
      } catch (error) {
        resolve({ code: 1, stdout: "", stderr: String(error.stderr ?? error.message) });
      }
    });
  const worktrees = createWorktrees({ agentDir, exec });

  await assert.rejects(worktrees.create(repo, "worker"), /could not copy uncommitted changes/);
  assert.ok(calls.includes("apply"));
  assert.deepEqual(await worktrees.listKept(repo), []);
  assert.doesNotMatch(git(repo, "branch"), /pi-subagent/);
});

test("outside a git repository create fails instead of running in place", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "subagent-wt-nogit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const worktrees = createWorktrees({ agentDir: path.join(dir, "agent") });
  await assert.rejects(worktrees.create(dir, "worker"), /git rev-parse failed/);
});

test("two isolated writers start together while an in-place writer still waits", async () => {
  const pool = createPool({ maxConcurrent: 4 });
  const inPlace = pool.acquire("worker", { write: true });
  const isolatedA = pool.acquire("worker", { write: true, isolated: true });
  const isolatedB = pool.acquire("worker", { write: true, isolated: true });
  const waiting = pool.acquire("worker", { write: true });

  assert.equal(inPlace.entry.status, "running");
  assert.equal(isolatedA.entry.status, "running");
  assert.equal(isolatedB.entry.status, "running");
  assert.equal(waiting.entry.status, "queued", "a second in-place writer keeps the writer lane");

  pool.release(isolatedA.entry.id);
  assert.equal(waiting.entry.status, "queued", "an isolated writer leaving frees no writer lane");
  pool.release(inPlace.entry.id);
  assert.equal((await waiting.ready).status, "running");
});
