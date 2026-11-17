// worktree.mjs — a git worktree per isolated child, so writers can run in parallel.
//
// A worktree starts at the parent's HEAD with the parent's uncommitted state
// copied in (tracked changes as a patch, untracked files as copies), because a
// child asked to attack or extend "the change" needs the dirty tree, not just
// HEAD. Worktrees live under <agentDir>/subagent-worktrees, never inside the
// repository, so the parent's drift and done-gate never see them. Nothing is
// merged back: the parent reads the result and decides what to graft.

import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { workingTree } from "../../shared/revision.mjs";

const WORKTREE_DIR = "subagent-worktrees";
const BRANCH_PREFIX = "pi-subagent/";
const MAX_DIFF_CHARS = 20_000;

/** git without a shell. Resolves {code, stdout, stderr}; never rejects. */
function runGit(args, { cwd } = {}) {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: 60_000, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? error?.message) });
      },
    );
  });
}

/**
 * @param {{ agentDir: string, exec?: typeof runGit, tree?: typeof workingTree }} options
 * `exec(args, {cwd})` runs git; tests inject one to fail a single step.
 */
export function createWorktrees({ agentDir, exec = runGit, tree = workingTree }) {
  const git = async (cwd, ...args) => {
    const r = await exec(args, { cwd });
    if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr.trim()}`);
    return r.stdout.trim();
  };

  /** Directory holding this repository's child worktrees, keyed by its shared git dir. */
  async function repoDir(cwd) {
    const common = await git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
    const key = createHash("sha256").update(common).digest("hex").slice(0, 12);
    return path.join(agentDir, WORKTREE_DIR, key);
  }

  async function discard(root, wt) {
    await exec(["worktree", "remove", "--force", wt.path], { cwd: root });
    await exec(["branch", "-D", wt.branch], { cwd: root });
  }

  /** Copy the parent's tracked changes (as one binary patch) and untracked files in. */
  async function copyDirtyState(root, wtPath) {
    const patch = await git(root, "diff", "--binary", "HEAD");
    if (patch) {
      // Through a file: the injected exec has no stdin, and neither does pi.exec.
      const file = path.join(tmpdir(), `pi-subagent-${randomBytes(6).toString("hex")}.patch`);
      try {
        await writeFile(file, `${patch}\n`);
        const applied = await exec(["apply", "--whitespace=nowarn", file], { cwd: wtPath });
        if (applied.code !== 0)
          throw new Error(`could not copy uncommitted changes: ${applied.stderr.trim()}`);
      } finally {
        await rm(file, { force: true });
      }
    }
    const untracked = await git(root, "ls-files", "--others", "--exclude-standard", "-z");
    for (const file of untracked.split("\0").filter(Boolean)) {
      const target = path.join(wtPath, file);
      await mkdir(path.dirname(target), { recursive: true });
      await cp(path.join(root, file), target, { recursive: true, verbatimSymlinks: true });
    }
  }

  return {
    /**
     * A new worktree on its own branch at the parent's HEAD, with the parent's
     * uncommitted state copied in. `cwd` is the parent's cwd mapped into it.
     */
    async create(parentCwd, id) {
      const root = await git(parentCwd, "rev-parse", "--show-toplevel");
      const base = await git(root, "rev-parse", "--verify", "HEAD");
      const unique = `${String(id || "child").replace(/[^\w.-]+/g, "-")}-${randomBytes(3).toString("hex")}`;
      const wtPath = path.join(await repoDir(root), unique);
      const branch = `${BRANCH_PREFIX}${unique}`;
      await mkdir(path.dirname(wtPath), { recursive: true });
      await git(root, "worktree", "add", "--quiet", "-b", branch, wtPath, base);
      const wt = { root, path: wtPath, branch, base, cwd: wtPath, baseline: null };
      try {
        await copyDirtyState(root, wtPath);
        wt.baseline = await tree(wtPath);
        if (!wt.baseline) throw new Error("could not record the worktree's starting tree");
      } catch (error) {
        await discard(root, wt);
        throw error;
      }
      const relative = path.relative(await realpath(root), await realpath(parentCwd));
      if (relative && !relative.startsWith("..")) wt.cwd = path.join(wtPath, relative);
      return wt;
    },

    /**
     * What the child left behind, measured from the tree it started with, so
     * the parent's copied changes are not attributed to it.
     */
    async describe(wt) {
      const [count, now] = await Promise.all([
        git(wt.path, "rev-list", "--count", `${wt.base}..HEAD`),
        tree(wt.path),
      ]);
      const commits = Number(count) || 0;
      if (!now) return { commits, changed: true, known: false, stat: "", diff: "" };
      if (now === wt.baseline)
        return { commits, changed: commits > 0, known: true, stat: "", diff: "" };
      const [stat, diff] = await Promise.all([
        git(wt.path, "diff", "--stat", wt.baseline, now),
        git(wt.path, "diff", wt.baseline, now),
      ]);
      return { commits, changed: true, known: true, stat, diff: diff.slice(0, MAX_DIFF_CHARS) };
    },

    /** Remove the worktree and its branch only when nothing would be lost. */
    async removeIfEmpty(wt) {
      const left = await this.describe(wt);
      if (left.changed || !left.known) return false;
      await discard(wt.root, wt);
      return true;
    },

    /** Child worktrees of this repository that still exist, from git's own list. */
    async listKept(cwd) {
      const dir = await repoDir(cwd);
      const dirs = [dir, await realpath(dir).catch(() => dir)];
      const listing = await git(cwd, "worktree", "list", "--porcelain");
      const kept = [];
      for (const block of listing.split(/\n\n+/)) {
        const wtPath = /^worktree (.+)$/m.exec(block)?.[1];
        const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? "";
        if (wtPath && dirs.some((d) => wtPath.startsWith(d + path.sep)))
          kept.push({ path: wtPath, branch });
      }
      return kept;
    },
  };
}

/** One line for the tool result naming where the child worked. */
export function worktreeLine(wt, left) {
  const commits = `${left.commits} commit${left.commits === 1 ? "" : "s"}`;
  const state = !left.known ? "state unknown" : left.changed ? "changed" : "no changes";
  return (
    `worktree: ${wt.path} (branch ${wt.branch}, base ${wt.base.slice(0, 12)}, ${commits}, ${state}). ` +
    "It started with your uncommitted changes copied in; nothing was merged back."
  );
}
