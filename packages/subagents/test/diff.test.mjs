import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { changedFiles, describeChanges, snapshotChanges } from "../diff.mjs";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, stdio: "ignore" });

test("only changes made after the snapshot are attributed", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "subagent-diff-"));
  git(cwd, "init", "-q");
  git(cwd, "config", "user.email", "t@example.com");
  git(cwd, "config", "user.name", "t");
  writeFileSync(path.join(cwd, "old.txt"), "1\n");
  writeFileSync(path.join(cwd, "keep.txt"), "1\n");
  git(cwd, "add", ".");
  git(cwd, "commit", "-q", "-m", "init");
  writeFileSync(path.join(cwd, "keep.txt"), "1\n2\n"); // pre-existing dirt

  const before = await snapshotChanges(cwd);
  writeFileSync(path.join(cwd, "old.txt"), "1\n2\n3\n");
  writeFileSync(path.join(cwd, "fresh.txt"), "new\n");
  const files = changedFiles(before, await snapshotChanges(cwd));

  assert.deepEqual(files.sort(), ["fresh.txt", "old.txt"]);
  const { stat, diff } = await describeChanges(cwd, files);
  assert.match(stat, /old\.txt/);
  assert.match(stat, /fresh\.txt \(new, untracked\)/);
  assert.match(diff, /\+3/);
});

test("outside a git repo everything is a quiet no-op", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "subagent-nogit-"));
  assert.equal(await snapshotChanges(cwd), undefined);
  assert.deepEqual(changedFiles(undefined, undefined), []);
});
