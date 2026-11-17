// tree.mjs — the content identity of a working tree, for /climb's revert check.
//
// revisionSnapshot (shared/revision.mjs) hashes HEAD together with the diff, so
// committing an accepted attempt changes its fingerprint although no file did.
// /climb leaves commits to the agent, so it compares content instead: the git
// tree object of every tracked and untracked, non-ignored file, built in a
// throwaway index. The real index, refs and files are never touched; the only
// side effect is blob objects in the object store, which `git gc` reclaims.

import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const TIMEOUT_MS = 60_000;

/** The tree id of the working tree's content, or null outside a usable git work tree. */
export async function workingTreeId(cwd) {
  const scratch = mkdtempSync(join(tmpdir(), "climb-index-"));
  const index = join(scratch, "index");
  const git = async (args, env) =>
    (
      await run("git", args, {
        cwd,
        env,
        timeout: TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      })
    ).stdout.trim();
  try {
    // Seeding from the real index reuses its stat cache, so unchanged files are not re-read.
    const real = resolve(cwd, await git(["rev-parse", "--git-path", "index"], process.env));
    if (existsSync(real)) {
      copyFileSync(real, index);
      // git re-checks an entry whose stat data matches only while it is "racily
      // clean" — its mtime is not older than the index file's. A copy stamped
      // with the current time is newer than every entry, which switches that
      // protection off: a same-size edit written in the entry's own timestamp
      // tick would be trusted as unchanged. Keep the source index's mtime.
      const { atime, mtime } = statSync(real);
      utimesSync(index, atime, mtime);
    }
    const env = { ...process.env, GIT_INDEX_FILE: index };
    await git(["add", "--all", "--", ":/"], env);
    return (await git(["write-tree"], env)) || null;
  } catch {
    return null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
