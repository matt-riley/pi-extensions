// Parent-specified command contracts + observed host events. Child prose is not evidence.
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
    const head = (await git("rev-parse", "HEAD")).trim();
    const hash = createHash("sha256");
    hash.update(head);
    hash.update(await git("diff", "--binary", "HEAD"));
    hash.update(await git("diff", "--cached", "--binary"));
    for (const file of (await git("ls-files", "--others", "--exclude-standard", "-z"))
      .split("\0")
      .filter(Boolean)
      .sort()) {
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

export function collectEvidence(events, event) {
  if (event?.type === "tool_execution_start" && event.toolName === "bash") {
    events.push({
      id: event.toolCallId,
      command: String(event.args?.command ?? ""),
      success: null,
      output: "",
    });
  } else if (event?.type === "tool_execution_end") {
    const record = events.findLast((item) => item.id === event.toolCallId);
    if (record) {
      record.success = event.isError === false ? true : event.isError === true ? false : null;
      record.output = (event.result?.content ?? [])
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n")
        .slice(0, 500);
    }
  }
}

export function assessEvidence({
  criteria = [],
  evidence = [],
  before,
  after,
  status,
  transcriptSaved = true,
}) {
  const sameRevision = Boolean(before?.fingerprint && before.fingerprint === after?.fingerprint);
  const checks = criteria.map(({ criterion, command }) => {
    const observed = evidence.findLast((item) => item.command === command);
    return { criterion, command, observed: observed ?? null };
  });
  const gaps = [];
  if (!criteria.length)
    gaps.push("No parent-specified acceptance commands; task outcome is unknown.");
  if (!sameRevision)
    gaps.push(
      "Revision unavailable or changed during the run; repeat checks against the final state.",
    );
  if (!transcriptSaved) gaps.push("Transcript could not be saved; evidence is not durable.");
  if (!["completed", "wrapped up"].includes(status)) gaps.push(`Execution ended: ${status}.`);
  for (const check of checks)
    if (check.observed?.success !== true) gaps.push(`Not passed: ${check.criterion}`);
  const failed = checks.some((check) => check.observed?.success === false);
  const outcome = failed
    ? "failed"
    : checks.length && !gaps.length
      ? "verified"
      : evidence.length || checks.length
        ? "partial"
        : "unknown";
  return {
    outcome,
    scope: "Only the parent-specified acceptance command contracts; not a model judgment",
    revision: after,
    before,
    checks,
    evidence,
    gaps,
  };
}
