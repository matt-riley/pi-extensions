// files.mjs — keep file and command content out of the agent's context.
//
// typesafe_ask's `paths` and `command` read locally and hand the content to
// Jev, so the agent gets typed answers back instead of the bytes. Everything
// here is deterministic and testable; the only model call is `ask`.
//
// Two safety layers, because this ships content to a third-party API:
//   - paths must resolve inside the repo (symlinks included) and must not look
//     like a secret (guardrail's own secret/.env rules);
//   - commands must pass both the read-only bash policy and the guardrail.

import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, matchesGlob, relative, resolve, sep } from "node:path";

import { blockedBashCommand } from "../../shared/bash-policy.mjs";
import { excerpt, mapPool, usable } from "../../shared/spans.mjs";
import { askSystemOne } from "../../shared/systemone.mjs";
import { findRepoRoot, listRepoFiles, normalizeRel } from "../code-search/inventory.mjs";
import { evaluateBashCommand, isEnvFile, isSecretPath } from "../guardrail/policy.mjs";

const MAX_FILES = 255;
const MAX_FILE_BYTES = 1_000_000;
const MAX_CONTENT_CHARS = 60_000;
const MAX_COMMAND_OUTPUT = 100_000;
const COMMAND_TIMEOUT_MS = 60_000;
const GLOB_CHARS = /[*?[\]{}]/;

const isSensitive = (rel) => isSecretPath(rel) || isEnvFile(rel);
const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

/** Repo-relative path for `input`, or a reason it may not be read. Never touches the disk. */
function locate(input, cwd, root) {
  const raw = relative(root, resolve(cwd, input));
  if (raw === ".." || raw.startsWith(`..${sep}`) || isAbsolute(raw)) {
    return { reason: "outside the repository" };
  }
  const rel = normalizeRel(raw);
  return isSensitive(rel) ? { reason: "looks like a secret" } : { rel };
}

/**
 * Expand paths, directories and globs to repo files. Inventory-backed (gitignore
 * exact), so node_modules and ignored files never appear unless named outright.
 * A directory means its direct children unless `recursive`.
 */
export async function resolveTargets({ patterns, cwd, exec, recursive = false }) {
  const { root } = await findRepoRoot(cwd, exec);
  const { files: inventory } = await listRepoFiles({ root, exec });
  const chosen = new Set();
  const skipped = [];
  for (const pattern of patterns) {
    const where = locate(pattern, cwd, root);
    if (where.reason) {
      skipped.push({ path: pattern, reason: where.reason });
      continue;
    }
    const { rel } = where;
    let matched;
    if (GLOB_CHARS.test(pattern)) {
      matched = inventory.filter((file) => matchesGlob(file, rel));
    } else if (inventory.includes(rel)) {
      matched = [rel];
    } else {
      const prefix = rel ? `${rel}/` : "";
      matched = inventory.filter(
        (file) =>
          file.startsWith(prefix) && (recursive || !file.slice(prefix.length).includes("/")),
      );
      if (matched.length === 0) {
        const info = await stat(resolve(root, rel)).catch(() => null);
        if (info?.isFile()) matched = [rel];
      }
    }
    if (matched.length === 0) skipped.push({ path: pattern, reason: "no match" });
    for (const file of matched) {
      if (isSensitive(file)) skipped.push({ path: file, reason: "looks like a secret" });
      else chosen.add(file);
    }
  }
  const files = [...chosen];
  for (const file of files.slice(MAX_FILES)) skipped.push({ path: file, reason: "over file cap" });
  return { root, files: files.slice(0, MAX_FILES), skipped };
}

/** Read one repo file as text, or say why not. Symlinks may not lead out of the repo. */
export async function loadText(root, rel) {
  const abs = resolve(root, rel);
  try {
    const [realRoot, real] = await Promise.all([realpath(root), realpath(abs)]);
    if (!real.startsWith(realRoot + sep)) return { skip: "outside the repository" };
    if (isSensitive(normalizeRel(relative(realRoot, real)))) return { skip: "looks like a secret" };
    const info = await stat(real);
    if (!info.isFile()) return { skip: "not a file" };
    if (info.size > MAX_FILE_BYTES) return { skip: "over 1MB" };
    const buffer = await readFile(real);
    if (buffer.subarray(0, 8000).includes(0)) return { skip: "binary" };
    return { text: buffer.toString("utf8") };
  } catch (error) {
    return { skip: errorMessage(error) };
  }
}

/** Resolve one user-supplied path for a single-file read; throws with the reason. */
export async function resolveReadable({ path, cwd, exec }) {
  const { root } = await findRepoRoot(cwd, exec);
  const where = locate(path, cwd, root);
  if (where.reason) throw new Error(`${path}: ${where.reason}`);
  const loaded = await loadText(root, where.rel);
  if (loaded.skip) throw new Error(`${path}: ${loaded.skip}`);
  return { rel: where.rel, text: loaded.text };
}

/** null when the command may run; otherwise the reason it may not. */
export function gateCommand(command, cwd) {
  const blocked = blockedBashCommand(command);
  if (blocked) return `command refused, not read-only: ${blocked}`;
  const { verdict, reason } = evaluateBashCommand(command, { cwd });
  return verdict === "allow" ? null : `command refused by the guardrail: ${reason ?? verdict}`;
}

/** Run a gated command in `cwd`; the output becomes state and never reaches the agent. */
export async function runCommand({ command, cwd, exec }) {
  const result = await exec("bash", ["-c", 'cd "$0" && eval "$1"', cwd, command], {
    timeout: COMMAND_TIMEOUT_MS,
  });
  const output = `${result.stdout ?? ""}${result.stderr ? `\n${result.stderr}` : ""}`;
  return { command, exit_code: result.code, output: excerpt(output, MAX_COMMAND_OUTPUT) };
}

/**
 * One Jev call per file, in parallel. `shared` state (e.g. command output) rides
 * along with every file. If every attempted file failed the same way (no key,
 * network down) that is a tool failure, not a hundred per-file errors.
 */
export async function askFiles({
  root,
  files,
  questions,
  shared = {},
  ask = askSystemOne,
  signal,
  concurrency = 8,
}) {
  const results = await mapPool(
    files,
    async (rel) => {
      const loaded = await loadText(root, rel);
      if (loaded.skip) return { path: rel, skipped: loaded.skip };
      const truncated = loaded.text.length > MAX_CONTENT_CHARS;
      const content = truncated ? loaded.text.slice(0, MAX_CONTENT_CHARS) : loaded.text;
      try {
        const { answers } = await ask({
          state: { ...shared, file: { path: rel, truncated, content } },
          questions,
          signal,
        });
        return { path: rel, answers };
      } catch (error) {
        return { path: rel, error: errorMessage(error) };
      }
    },
    concurrency,
  );
  const attempted = results.filter((r) => !r.skipped);
  if (attempted.length > 0 && attempted.every((r) => r.error)) throw new Error(attempted[0].error);
  return results;
}

/** The value a file is ranked by: probability for noul, position for score. */
function rankValue(answer) {
  if (answer?.type === "noul") return usable(answer.noul);
  if (answer?.type === "score") return usable(answer.score);
  return null;
}

function summarizeAnswer(id, answer) {
  if (answer?.type === "noul") {
    const value = usable(answer.noul);
    return value === null ? `${id} n/a` : `${id} noul ${value.toFixed(2)}`;
  }
  if (answer?.type === "score") {
    const value = usable(answer.score);
    return value === null ? `${id} n/a` : `${id} score ${value.toFixed(2)}`;
  }
  if (answer?.type === "choice" && typeof answer.choice === "string") {
    const confidence = usable(answer.confidence);
    return `${id} choice "${answer.choice}"${confidence === null ? "" : ` (${confidence.toFixed(2)})`}`;
  }
  return `${id} n/a`;
}

export function formatFileResults({ results, skipped = [], rankBy }) {
  const judged = results.filter((r) => r.answers);
  if (rankBy) {
    // Missing values sort last; equal values keep input order (sort is stable).
    const valueOf = (r) => rankValue(r.answers[rankBy]) ?? Number.NEGATIVE_INFINITY;
    judged.sort((a, b) => valueOf(b) - valueOf(a));
  }
  const failed = results.filter((r) => r.error);
  const notRead = [
    ...skipped,
    ...results.filter((r) => r.skipped).map((r) => ({ path: r.path, reason: r.skipped })),
  ];
  const lines = [
    `${judged.length} file(s) judged${rankBy ? `, ranked by ${rankBy} (highest first)` : ""}` +
      `${failed.length ? `, ${failed.length} failed` : ""}${notRead.length ? `, ${notRead.length} skipped` : ""}`,
  ];
  for (const r of judged) {
    lines.push(
      `${r.path}: ${Object.entries(r.answers)
        .map(([id, a]) => summarizeAnswer(id, a))
        .join(" · ")}`,
    );
  }
  for (const r of failed) lines.push(`${r.path}: failed: ${r.error}`);
  for (const s of notRead) lines.push(`${s.path}: skipped: ${s.reason}`);
  return lines.join("\n");
}
