import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const exec = async (cmd, args) => {
  try {
    const result = await run(cmd, args, { maxBuffer: 4 * 1024 * 1024 });
    return { ...result, code: 0 };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
};

test("repository picker separates index and worktree, handles renames and literal filenames", async (t) => {
  const { projectFiles, changedFiles, previewChange } = await import("../repository.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-workbench-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => run("git", ["-C", root, ...args]);
  await git("init", "-q");
  await git("config", "user.name", "Fixture");
  await git("config", "user.email", "fixture@example.invalid");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
  await writeFile(path.join(root, "src", "both.txt"), "base\n");
  await writeFile(path.join(root, "old.txt"), "old\n");
  await git("add", ".");
  await git("commit", "-qm", "test: seed fixture");
  await writeFile(path.join(root, "src", "both.txt"), "index\n");
  await git("add", ".");
  await writeFile(path.join(root, "src", "both.txt"), "worktree\n");
  await git("mv", "old.txt", "new name.txt");
  const strange = ":(glob)*[x]\n.txt";
  await writeFile(path.join(root, strange), "untracked\n");
  await writeFile(path.join(root, "ignored.txt"), "secret\n");

  const inventory = await projectFiles(path.join(root, "src"), exec);
  assert.equal(inventory.root, await realpath(root));
  assert.ok(inventory.files.includes(strange));
  assert.ok(!inventory.files.includes("ignored.txt"));
  const before = await readFile(path.join(root, ".git", "index"));
  const changes = await changedFiles(root, exec);
  assert.equal(changes.length, 4);
  const staged = changes.find((item) => item.file === "src/both.txt" && item.scope === "staged");
  const unstaged = changes.find(
    (item) => item.file === "src/both.txt" && item.scope === "unstaged",
  );
  assert.ok(staged);
  assert.ok(unstaged);
  assert.match(await previewChange(root, staged, exec), /\+index/);
  assert.doesNotMatch(await previewChange(root, staged, exec), /worktree/);
  assert.match(await previewChange(root, unstaged, exec), /\+worktree/);
  const renamed = changes.find((item) => item.file === "new name.txt");
  assert.equal(renamed.original, "old.txt");
  const renameDiff = await previewChange(root, renamed, exec);
  assert.match(renameDiff, /old.txt/);
  assert.match(renameDiff, /new name.txt/);
  const untracked = changes.find((item) => item.file === strange);
  assert.match(await previewChange(root, untracked, exec), /\+untracked/);
  assert.deepEqual(await readFile(path.join(root, ".git", "index")), before);
});

test("Git failures are errors, never a clean-worktree result", async () => {
  const { changedFiles, previewChange } = await import("../repository.mjs");
  const fail = async () => ({ code: 128, stdout: "", stderr: "not a git repository" });
  await assert.rejects(changedFiles("/missing", fail), /not a git repository/);
  await assert.rejects(
    previewChange("/missing", { scope: "staged", file: "a" }, fail),
    /not a git repository/,
  );
});

test("diff previews disable external drivers, use literal pathspecs and announce truncation", async () => {
  const { previewChange } = await import("../repository.mjs");
  const calls = [];
  const result = await previewChange(
    "/repo",
    { scope: "unstaged", file: ":(glob)*" },
    async (cmd, args) => {
      calls.push({ cmd, args });
      return { code: 0, stdout: "x".repeat(30000), stderr: "" };
    },
  );
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes("--literal-pathspecs"));
  assert.ok(calls[0].args.includes("--no-ext-diff"));
  assert.ok(calls[0].args.includes("--no-textconv"));
  assert.equal(calls[0].args.at(-1), ":(glob)*");
  assert.match(result, /preview truncated/);
  assert.ok(result.length < 21000);
});
