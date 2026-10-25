import { resolve } from "node:path";

const same = (a, b) =>
  Boolean(a?.fingerprint && a.head === b?.head && a.fingerprint === b.fingerprint);

/** Only real, untouched, completed results from this cwd and current revision. */
export function completedJobCheck(event, cwd, current) {
  const job = event?.toolName === "terminal_read" ? event.details?.job : null;
  if (
    job?.version !== 1 ||
    typeof job.command !== "string" ||
    typeof job.cwd !== "string" ||
    job.status !== "exited" ||
    !Number.isInteger(job.exit_code) ||
    job.exit_code < 0 ||
    job.signal !== null ||
    job.cleanup_error !== null ||
    job.interacted !== false ||
    job.owner !== "agent" ||
    resolve(job.cwd) !== resolve(cwd ?? process.cwd()) ||
    !same(job.before, job.after) ||
    !same(job.after, current)
  )
    return null;
  return {
    toolName: "bash",
    input: { command: job.command },
    cwd: job.cwd,
    isError: job.exit_code !== 0,
    before: job.before,
    after: current,
    content: [{ type: "text", text: job.output }],
  };
}
