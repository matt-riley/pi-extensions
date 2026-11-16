// drift.mjs — what changed in the working tree outside this session.
//
// A snapshot is the tree fingerprint (shared/revision.mjs) plus a hash per
// changed file, so two snapshots can be compared and the differences named.
// Git repos only; no model call, no network. Ignore handling is git's own
// (`--exclude-standard`) plus the two paths code-search always leaves out.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { revisionSnapshot } from "../../shared/revision.mjs";

const run = promisify(execFile);
const MAX_FILES = 200;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_LISTED = 12;
const ALWAYS_EXCLUDED = [/^\.pi\/cache\//, /(^|\/)node_modules\//, /^\.git\//];

const git = async (cwd, ...args) =>
  (await run("git", ["-C", cwd, ...args], { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 })).stdout;

const included = (file) => !ALWAYS_EXCLUDED.some((pattern) => pattern.test(file));
const nul = (text) => text.split("\0").filter(Boolean);

async function hashFile(cwd, file) {
  try {
    const target = path.resolve(cwd, file);
    const stat = await lstat(target);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return `size:${stat.size}`;
    return createHash("sha1")
      .update(await readFile(target))
      .digest("hex");
  } catch {
    return "gone";
  }
}

/** The tree now: HEAD, the fingerprint, and a content hash per dirty or untracked file. Null if git cannot say. */
export async function takeSnapshot(cwd) {
  try {
    const [revision, dirty, untracked] = await Promise.all([
      revisionSnapshot(cwd),
      git(cwd, "diff", "--name-only", "-z", "--relative", "HEAD"),
      git(cwd, "ls-files", "--others", "--exclude-standard", "-z"),
    ]);
    if (!revision) return null;
    const names = [...nul(dirty), ...nul(untracked)].filter(included).sort();
    const all = [...new Set(names)];
    const unique = all.slice(0, MAX_FILES);
    const hashes = await Promise.all(unique.map((file) => hashFile(cwd, file)));
    const files = new Map(unique.map((file, i) => [file, hashes[i]]));
    return { ...revision, files, capped: all.length > MAX_FILES };
  } catch {
    return null;
  }
}

/**
 * What differs between two snapshots, or null for nothing worth naming.
 * `files` is sorted; `headMoved` is set when a commit or checkout moved HEAD.
 */
export async function driftBetween(cwd, before, after) {
  if (!before || !after || before.fingerprint === after.fingerprint) return null;
  const changed = new Set();
  for (const file of new Set([...before.files.keys(), ...after.files.keys()])) {
    if (before.files.get(file) !== after.files.get(file)) changed.add(file);
  }
  let headMoved = null;
  if (before.head !== after.head) {
    headMoved = { from: before.head, to: after.head };
    try {
      for (const file of nul(
        await git(cwd, "diff", "--name-only", "-z", before.head, after.head),
      ).filter(included)) {
        changed.add(file);
      }
    } catch {
      // An unreachable old HEAD still counts as a move; the files stay unnamed.
    }
  }
  if (changed.size === 0 && !headMoved) return null;
  return { files: [...changed].sort(), headMoved, capped: before.capped || after.capped };
}

const short = (sha) => String(sha).slice(0, 7);

/** The prompt section: short, names files, says what to do. */
export function driftSection({ files, headMoved, capped }) {
  const shown = files.slice(0, MAX_LISTED);
  const more = files.length - shown.length;
  const list = shown.join(", ") + (more > 0 ? ` and ${more} more` : "");
  const lines = ["# Changed outside this session"];
  if (files.length > 0) {
    lines.push(
      `Since your last run settled, ${files.length} path(s) changed that your tools, subagents and jobs did not touch: ${list}${capped ? " (the list may be incomplete)" : ""}.`,
    );
  }
  if (headMoved) {
    lines.push(`HEAD moved from ${short(headMoved.from)} to ${short(headMoved.to)}.`);
  }
  lines.push(
    "Treat earlier reads and edits of these as stale: re-read them before relying on them, and do not overwrite them from memory.",
  );
  return lines.join("\n");
}

// --- the session's own background work ---------------------------------------

/** Subagents and jobs the session started and has not seen finish. */
export function createTracker() {
  return { subagents: new Set(), jobs: new Set() };
}

export function isBusy(tracker) {
  return tracker.subagents.size > 0 || tracker.jobs.size > 0;
}

/** `subagents:started|completed|failed|stopped` from pi.events (a child starts only once the writer lane lets it). */
export function noteSubagent(tracker, name, payload) {
  const id = String(payload?.id ?? "");
  if (!id) return;
  if (name === "subagents:started") tracker.subagents.add(id);
  else if (/^subagents:(completed|failed|stopped)$/.test(name)) tracker.subagents.delete(id);
}

/** A jobs tool result carries the job's status; only a running job keeps the tracker busy. */
export function noteJobs(tracker, event) {
  if (!String(event?.toolName ?? "").startsWith("terminal_")) return;
  const job = event?.details?.job;
  if (typeof job?.id !== "string") return;
  if (job.status === "running") tracker.jobs.add(job.id);
  else tracker.jobs.delete(job.id);
}
