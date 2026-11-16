// revision.mjs — a fingerprint of the working tree, so evidence can say which
// revision it was gathered at. Shared because subagents, jobs, done-gate and
// diagnosis-nudge all bind their evidence to it.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, lstat } from "node:fs/promises";
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
