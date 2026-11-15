// user-bash.mjs — when Matt's own `!` run counts as the check the gate wants.
//
// Pi saves a `!` run as a `bashExecution` message when it finishes. That message
// is the only thing trusted: `user_bash` fires when a run *starts*, so it is used
// to remember the tree as it was then and nothing else. A run counts only if
//   - it is a recognised check (isVerifyCommand),
//   - it exited 0, was not cancelled, and its output was not truncated,
//   - it was not `!!` (excludeFromContext): that output never reached the model,
//   - and the tree now is the tree it started on, so nothing, including the run
//     itself, changed the code since.
// The newest recognised run decides, so a later failure undoes an earlier pass.

import { isVerifyCommand } from "./gate.mjs";

const sameRevision = (before, after) =>
  Boolean(
    before?.fingerprint && before.head === after?.head && before.fingerprint === after?.fingerprint,
  );

/**
 * @param {{ messages: unknown[], started: Array<{ command: string, at: number, before: object | null }>, current: object | null }} input
 *   `messages` are the session's messages; `started` are the `user_bash` starts seen
 *   this process; `current` is the revision snapshot now.
 * @returns {{ revision: object, command: string, output: string } | null}
 */
export function userBashEvidence({ messages, started, current }) {
  const runs = (messages ?? []).filter(
    (message) => message?.role === "bashExecution" && isVerifyCommand(message.command),
  );
  const run = runs.at(-1);
  if (!run) return null;
  if (run.exitCode !== 0 || run.cancelled === true || run.truncated === true) return null;
  if (run.excludeFromContext === true) return null;
  const start = (started ?? [])
    .filter((item) => item.command === run.command && item.at <= run.timestamp)
    .sort((a, b) => b.at - a.at)[0];
  return start && sameRevision(start.before, current)
    ? { revision: current, command: run.command, output: String(run.output ?? "") }
    : null;
}
