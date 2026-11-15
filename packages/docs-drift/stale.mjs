// stale.mjs — is a doc older than the code it describes, by git history alone.
//
// For each tracked doc: find the commit that last touched it, then ask git for
// the commits after that one that touched the code the doc maps to (mapping.mjs).
// Any such commit makes the doc `stale`; none makes it `current`. When the doc
// maps to no code, or git cannot give a trustworthy history (not a repository, no
// commits, a shallow clone), the answer is `can't tell`: it is never `current` by
// default. Only committed history counts; uncommitted edits are not looked at.
//
// `exec` is injected (pi.exec in index.ts, a real git in tests) and every git
// command runs as an argument vector, never through a shell.

import { isDocPath, mapDoc } from "./mapping.mjs";

const TIMEOUT_MS = 20_000;
/** Pathspecs per `git log` call, so a README over a large tree stays one short command. */
const CHUNK = 200;
const SHOWN_CHANGES = 5;
const STALE = "stale";
const CURRENT = "current";
const UNKNOWN = "can't tell";

/**
 * @typedef {{ path: string, sha: string, date: string }} Change
 * @typedef {{
 *   path: string,
 *   status: "stale" | "current" | "can't tell",
 *   reason: string,
 *   doc: { sha: string, date: string } | null,
 *   mapped: { path: string, via: string }[],
 *   changed: Change[],
 * }} DocReport
 */

const unknown = (path, reason) => ({
  path,
  status: UNKNOWN,
  reason,
  doc: null,
  mapped: [],
  changed: [],
});

const report = (docs) => {
  const summary = { [STALE]: 0, [CURRENT]: 0, [UNKNOWN]: 0 };
  for (const doc of docs) summary[doc.status]++;
  return { docs, summary };
};

/** `[sha, date]` of the newest commit for each file a log lists, newest first. */
function parseLog(stdout) {
  const commits = [];
  for (const chunk of String(stdout).split("\x01").slice(1)) {
    const end = chunk.indexOf("\0");
    const [sha, date] = chunk.slice(0, end).split("\t");
    const names = chunk
      .slice(end + 1)
      .replace(/^\n/, "")
      .split("\0")
      .filter(Boolean);
    commits.push({ sha, date, names });
  }
  return commits;
}

/**
 * Judge every doc in the repository (or only those under `prefixes`).
 * @param {{
 *   exec: (cmd: string, args: string[], opts?: { timeout?: number }) =>
 *     Promise<{ code: number, stdout: string, stderr: string }>,
 *   root: string,
 *   readFile: (rel: string) => Promise<string | null>,
 *   prefixes?: string[],
 * }} input
 */
export async function checkDocs({ exec, root, readFile, prefixes = [] }) {
  const git = (...args) =>
    exec("git", ["-C", root, "--literal-pathspecs", ...args], { timeout: TIMEOUT_MS }).catch(
      (error) => ({ code: 1, stdout: "", stderr: String(error?.message ?? error) }),
    );

  const shallow = await git("rev-parse", "--is-shallow-repository");
  if (shallow.code !== 0) return report([unknown("(repository)", "not a git repository")]);

  const listed = await git("ls-files", "-z");
  const files = new Set(listed.stdout.split("\0").filter(Boolean));
  const paths = [...files]
    .filter(isDocPath)
    .filter(
      (path) =>
        prefixes.length === 0 ||
        prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`)),
    )
    .sort();

  const head = await git("rev-parse", "--verify", "-q", "HEAD");
  const blocker =
    head.code !== 0
      ? "no commits yet, so there is no history"
      : shallow.stdout.trim() === "true"
        ? "shallow clone: the history is incomplete (fetch it with `git fetch --unshallow`)"
        : null;
  if (blocker) return report(paths.map((path) => unknown(path, blocker)));

  const found = new Map();
  const find = async (name) => {
    if (!found.has(name)) {
      const result = await git("grep", "-l", "-z", "-w", "-F", "-e", name);
      found.set(name, result.code === 0 ? result.stdout.split("\0").filter(Boolean) : []);
    }
    return found.get(name);
  };

  const docs = [];
  for (const path of paths) docs.push(await judge({ git, path, files, find, readFile }));
  return report(docs);
}

async function judge({ git, path, files, find, readFile }) {
  const text = await readFile(path);
  if (text === null) return unknown(path, "could not read the doc");
  const mapping = await mapDoc({ doc: path, text, files, find });
  if (mapping.files.length === 0) {
    return unknown(path, "no code mapped: it names no tracked file, directory or identifier");
  }

  const last = await git("log", "-1", "--format=%H%x09%cI", "--", path);
  const [sha, date] = last.stdout.trim().split("\t");
  if (last.code !== 0 || !sha) return unknown(path, "no commit found for the doc");

  const covered = new Set(mapping.files.map((item) => item.path));
  const loose = mapping.files
    .map((item) => item.path)
    .filter((p) => !mapping.dirs.some((d) => p.startsWith(`${d}/`)));
  const specs = [...mapping.dirs, ...loose];
  const changed = new Map();
  for (let i = 0; i < specs.length; i += CHUNK) {
    const log = await git(
      "log",
      `${sha}..HEAD`,
      "--format=%x01%H%x09%cI",
      "--name-only",
      "-z",
      "--",
      ...specs.slice(i, i + CHUNK),
    );
    if (log.code !== 0) return unknown(path, "git log failed for the mapped code");
    for (const commit of parseLog(log.stdout)) {
      for (const name of commit.names) {
        if (covered.has(name) && !changed.has(name)) {
          changed.set(name, { path: name, sha: commit.sha, date: commit.date });
        }
      }
    }
  }

  const list = [...changed.values()].sort((a, b) =>
    a.date === b.date ? (a.path < b.path ? -1 : 1) : a.date < b.date ? 1 : -1,
  );
  return {
    path,
    status: list.length > 0 ? STALE : CURRENT,
    reason:
      list.length > 0
        ? `${list.length} of ${covered.size} mapped files changed after the doc's last commit`
        : `none of ${covered.size} mapped files changed after the doc's last commit`,
    doc: { sha, date },
    mapped: mapping.files,
    changed: list,
  };
}

const day = (iso) => String(iso).slice(0, 10);
const short = (sha) => String(sha).slice(0, 7);

function line(doc) {
  if (!doc.doc) return `${doc.status}\t${doc.path}\t${doc.reason}`;
  const since = `doc last changed ${day(doc.doc.date)} (${short(doc.doc.sha)})`;
  if (doc.status === CURRENT) return `${doc.status}\t${doc.path}\t${since}; ${doc.reason}`;
  const shown = doc.changed
    .slice(0, SHOWN_CHANGES)
    .map((item) => `${item.path} ${day(item.date)} (${short(item.sha)})`);
  const more = doc.changed.length - shown.length;
  return `${doc.status}\t${doc.path}\t${since}; changed since: ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`;
}

/** One tab-separated line per doc, status first, then a summary line. */
export function formatText({ docs, summary }) {
  if (docs.length === 0) return "docs-drift: no docs found";
  const total = `${docs.length} doc${docs.length === 1 ? "" : "s"}`;
  return [
    ...docs.map(line),
    `docs-drift: ${summary[STALE]} stale, ${summary[CURRENT]} current, ${summary[UNKNOWN]} can't tell (${total})`,
  ].join("\n");
}

export function formatJson(result) {
  return JSON.stringify(result, null, 2);
}
