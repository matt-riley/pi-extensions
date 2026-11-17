// runs.mjs — the `.pi/runs/` log directory that /until, /climb and the
// decision trail append to. The directory carries its own `.gitignore` of `*`,
// so the logs stay out of git and out of every working-tree fingerprint
// (revisionSnapshot lists untracked files through git's exclude rules).

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { tsvRow } from "./tsv.mjs";

/** Create `<cwd>/.pi/runs` with its ignore file, and return its path. Throws when it cannot. */
export function ensureRunsDir(cwd) {
  const dir = join(cwd, ".pi", "runs");
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  return dir;
}

/**
 * Append one timestamped row to a run log. The log records a loop; it is not
 * part of it, so a failed append (a deleted directory, a full disk) is dropped
 * rather than allowed to stop the loop being recorded elsewhere.
 */
export function appendRunRow(path, cells) {
  try {
    appendFileSync(path, tsvRow([new Date().toISOString(), ...cells]));
  } catch {
    // The log is a convenience; never let it break the loop.
  }
}

/** `<name>-<iso timestamp>.tsv` in the runs directory, created with `header`. */
export function startRunLog(cwd, name, header) {
  const path = join(
    ensureRunsDir(cwd),
    `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}.tsv`,
  );
  appendFileSync(path, header);
  return path;
}
