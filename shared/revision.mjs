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

/** git with `input` on stdin; resolves stdout, or null on any failure. */
function gitWithInput(cwd, args, input) {
  return new Promise((resolve) => {
    const child = execFile(
      "git",
      args,
      { cwd, timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => resolve(error ? null : String(stdout)),
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

/**
 * Stable id of a change, unaffected by rebase: `git patch-id --stable` of the
 * diff from the merge base of `base` to `head`, or to the working tree as it
 * stands (untracked files included) when `head` is omitted. A rebase changes
 * every SHA without failing any check; the patch id changes only when the
 * change does. Null when it cannot be computed or the change is empty.
 */
export async function patchId(cwd, base, head) {
  try {
    const git = async (...args) =>
      (await run("git", args, { cwd, timeout: 30000, maxBuffer: 64 * 1024 * 1024 })).stdout;
    const tip = head ?? "HEAD";
    const mergeBase = (await git("merge-base", base, tip)).trim();
    const target = head ?? (await workingTree(cwd));
    if (!mergeBase || !target) return null;
    const diff = await git("diff", "--no-color", "--no-ext-diff", mergeBase, target);
    if (!diff.trim()) return null;
    const id = await gitWithInput(cwd, ["patch-id", "--stable"], diff);
    return id?.split(/\s+/)[0] || null;
  } catch {
    return null;
  }
}

/** The branch changes are measured against: origin's default branch, else main, else master. */
export async function defaultBase(cwd) {
  const verify = async (ref) => {
    try {
      await run("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
        cwd,
        timeout: 10000,
      });
      return true;
    } catch {
      return false;
    }
  };
  try {
    const { stdout } = await run(
      "git",
      ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"],
      { cwd, timeout: 10000 },
    );
    if (stdout.trim() && (await verify(stdout.trim()))) return stdout.trim();
  } catch {
    // no origin/HEAD
  }
  for (const ref of ["origin/main", "main", "origin/master", "master"])
    if (await verify(ref)) return ref;
  return null;
}
