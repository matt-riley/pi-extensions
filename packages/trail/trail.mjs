// trail.mjs — the decision trail: an append-only TSV of the forks, finished
// units, pivots and blockers of a task, each with an evidence pointer. index.ts
// owns pi wiring; this module owns the file and the evidence check.
//
// A wrong row is superseded by a new one, never edited. When a session first
// adds to a log that already exists, a `start` row marks where it begins.

import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { ensureRunsDir } from "../../shared/runs.mjs";
import { findStalePaths } from "../../shared/stalepaths.mjs";
import { tsvRow } from "../../shared/tsv.mjs";

const TRAIL_HEADER = tsvRow(["ts", "phase", "decision", "why", "evidence", "result"]);
const MAX_SHAS = 8;
// Seven to forty hex digits with at least one letter and one digit, so plain
// numbers (PR #123, a line count) and hex-looking words ("decade") are not SHAs.
const SHA = /(?<![\w./:-])(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}(?![\w/-])/g;
const SLASH_PATH = /(?:[\w@.-]+\/)+[\w@-][\w@.-]*\.[A-Za-z0-9]{1,8}/g;
const PATH_LINE =
  /(?<![\w/:.@-])((?:\/|\.{1,2}\/|~\/)?(?:[\w@.-]+\/)*[\w@-][\w@.-]*\.[A-Za-z0-9]{1,8}):(\d+)\b/g;

/** Where the trail lives: `<cwd>/.pi/runs/decisions.tsv`. */
export function trailPath(cwd) {
  return join(cwd, ".pi", "runs", "decisions.tsv");
}

/**
 * Append one decision row, with the header for a new file and a `start` row
 * the first time this session writes to an existing log. Returns the file path.
 * @param {string} cwd
 * @param {{phase:string, decision:string, why:string, evidence:string, result:string}} row
 * @param {{started:boolean, session?:string, now?:Date}} state
 */
export function appendDecision(cwd, row, state) {
  ensureRunsDir(cwd);
  const file = trailPath(cwd);
  const ts = (state.now ?? new Date()).toISOString();
  const fresh = !existsSync(file) || statSync(file).size === 0;
  let text = fresh ? TRAIL_HEADER : "";
  if (!state.started && !fresh)
    text += tsvRow([
      ts,
      "start",
      `session ${state.session || "unknown"} adds to this log`,
      "",
      "",
      "",
    ]);
  text += tsvRow([ts, row.phase, row.decision, row.why, row.evidence, row.result]);
  appendFileSync(file, text);
  return file;
}

/** Whether the file has line `line`. */
function lineExists(file, line) {
  try {
    if (!statSync(file).isFile()) return false;
    return line >= 1 && readFileSync(file, "utf8").split("\n").length >= line;
  } catch {
    return false;
  }
}

/**
 * Check that an evidence pointer resolves: named paths exist, `path:line`
 * names a real line, and commit SHAs are known to git. Commands, PR numbers
 * and prose are not checkable here and pass. `git(args)` resolves `{code}`.
 * @returns {Promise<{ok:boolean, problems:string[], checked:number}>}
 */
export async function checkEvidence(evidence, cwd, git) {
  const text = String(evidence ?? "");
  const stale = findStalePaths(text, cwd);
  const problems = stale.map((p) => `${p} does not exist`);
  let checked = (text.match(SLASH_PATH) ?? []).length;
  for (const match of text.matchAll(PATH_LINE)) {
    checked += 1;
    const [, written, line] = match;
    if (stale.includes(written)) continue;
    let file;
    if (written.startsWith("~/")) file = join(homedir(), written.slice(2));
    else if (isAbsolute(written)) file = written;
    else file = resolve(cwd, written);
    if (!existsSync(file)) problems.push(`${written} does not exist`);
    else if (!lineExists(file, Number(line))) problems.push(`${written} has no line ${line}`);
  }
  const shas = [...new Set(text.match(SHA) ?? [])].slice(0, MAX_SHAS);
  for (const sha of shas) {
    checked += 1;
    const result = await git(["cat-file", "-e", `${sha}^{commit}`]);
    if (result?.code !== 0) problems.push(`${sha} is not a commit in this repository`);
  }
  return { ok: problems.length === 0, problems, checked };
}

/** The tool's one-line answer. */
export function describeResult(file, check) {
  if (!check.ok)
    return `logged to ${file}; evidence does not resolve: ${check.problems.join("; ")}`;
  if (check.checked === 0)
    return `logged to ${file}; evidence names no path or commit to check, so it is unverified`;
  return `logged to ${file}; evidence resolves`;
}
