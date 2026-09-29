// diff.mjs — what did a write-capable child actually change? Real git output,
// not the child's own claim. Snapshot before, compare after, so changes that
// were already in the worktree are not attributed to the child.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const MAX_DIFF_CHARS = 20_000;

async function git(cwd, args) {
  const { stdout } = await run("git", args, { cwd, maxBuffer: 8 * 1024 * 1024, timeout: 10_000 });
  return stdout;
}

/** path -> "added\tdeleted" for tracked changes; untracked paths map to "new". */
export async function snapshotChanges(cwd) {
  try {
    const snap = new Map();
    for (const line of (await git(cwd, ["diff", "HEAD", "--numstat"])).split("\n")) {
      const [added, deleted, ...file] = line.split("\t");
      if (file.length > 0) snap.set(file.join("\t"), `${added}\t${deleted}`);
    }
    const untracked = await git(cwd, ["ls-files", "--others", "--exclude-standard"]);
    for (const file of untracked.split("\n")) if (file) snap.set(file, "new");
    return snap;
  } catch {
    return undefined; // not a git repo, or git unavailable
  }
}

/** Files whose change differs between two snapshots. */
export function changedFiles(before, after) {
  if (!before || !after) return [];
  return [...after].filter(([file, stat]) => before.get(file) !== stat).map(([file]) => file);
}

/** Human-readable stat plus (capped) diff text for the judge. */
export async function describeChanges(cwd, files) {
  if (files.length === 0) return { stat: "", diff: "" };
  try {
    const tracked = (await git(cwd, ["diff", "HEAD", "--", ...files])).slice(0, MAX_DIFF_CHARS);
    const stat = (await git(cwd, ["diff", "HEAD", "--stat", "--", ...files])).trim();
    const untracked = await git(cwd, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "--",
      ...files,
    ]);
    const added = untracked.split("\n").filter(Boolean);
    return {
      stat: [stat, ...added.map((file) => `${file} (new, untracked)`)].filter(Boolean).join("\n"),
      diff: tracked,
    };
  } catch {
    return { stat: files.join("\n"), diff: "" };
  }
}
