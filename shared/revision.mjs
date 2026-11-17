// revision.mjs — a fingerprint of the working tree, so evidence can say which
// revision it was gathered at. Shared because subagents, jobs, done-gate and
// diagnosis-nudge all bind their evidence to it.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, readFile, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
const run = promisify(execFile);

export async function revisionSnapshot(cwd) {
  try {
    const git = async (...args) =>
      (await run("git", args, { cwd, timeout: 10000, maxBuffer: 8 * 1024 * 1024 })).stdout;
    // Independent reads: spawn them together, hash in the fixed order below.
    const [rev, worktree, staged, untracked] = await Promise.all([
      git("rev-parse", "HEAD"),
      git("diff", "--binary", "HEAD"),
      git("diff", "--cached", "--binary"),
      git("ls-files", "--others", "--exclude-standard", "-z"),
    ]);
    const head = rev.trim();
    const hash = createHash("sha256");
    hash.update(head);
    hash.update(worktree);
    hash.update(staged);
    for (const file of untracked.split("\0").filter(Boolean).sort()) {
      const target = path.resolve(cwd, file);
      const stat = await lstat(target);
      // Unknown/nonregular files cannot produce trusted evidence identity.
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return null;
      hash
        .update(file)
        .update("\0")
        .update(await readFile(target))
        .update("\0");
    }
    return { head, fingerprint: hash.digest("hex") };
  } catch {
    return null;
  }
}

/**
 * The tree object of the working tree as it stands: HEAD plus staged, unstaged
 * and untracked (not ignored) files. Built in a throwaway index, so the real
 * index is never touched; only loose objects are added to the object store.
 * Two calls return the same id exactly when the trees match. Null outside git.
 */
export async function workingTree(cwd) {
  const index = path.join(tmpdir(), `pi-tree-${process.pid}-${Date.now()}-${Math.random()}`);
  const git = async (env, ...args) =>
    (
      await run("git", args, { cwd, env, timeout: 30000, maxBuffer: 8 * 1024 * 1024 })
    ).stdout.trim();
  const scratch = { ...process.env, GIT_INDEX_FILE: index };
  try {
    // Asked without the override: --git-path answers with GIT_INDEX_FILE when it is set.
    const real = path.resolve(cwd, await git(process.env, "rev-parse", "--git-path", "index"));
    // Starting from the real index keeps its stat cache, so unchanged files are not rehashed.
    try {
      await copyFile(real, index);
    } catch {
      await git(scratch, "read-tree", "HEAD");
    }
    await git(scratch, "add", "-A");
    return (await git(scratch, "write-tree")) || null;
  } catch {
    return null;
  } finally {
    await rm(index, { force: true });
  }
}
