// policy-persistence.mjs — commands and writes that make something run again
// later, without anyone asking: cron, launchd, systemd and `at`. An agent has no
// reason to set these up unprompted, and a job that outlives the session is the
// one effect a dialog cannot take back, so they are refused rather than asked
// about. Listing and status commands are untouched.

import { findHead } from "../../shared/shell-parse.mjs";
import { isPersistencePath } from "./policy-targets.mjs";

const ELEVATORS = new Set(["sudo", "doas"]);
const ELEVATOR_VALUE_FLAGS = new Set(["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T", "-U"]);

const LAUNCHCTL_INSTALL = new Set(["load", "bootstrap", "enable", "submit"]);
const SYSTEMCTL_INSTALL = new Set([
  "enable",
  "reenable",
  "link",
  "preset",
  "preset-all",
  "add-wants",
  "add-requires",
  "edit",
]);
const SYSTEMD_VALUE_FLAGS = new Set(
  ["-H", "--host", "-M", "--machine", "-t", "--type", "-p", "--property", "-s", "--signal"].concat([
    "-n",
    "--lines",
    "-o",
    "--output",
    "--state",
    "--root",
    "--kill-whom",
  ]),
);

/** `sudo -u root crontab -e` is `crontab -e`. */
function underElevation(head, args) {
  if (!ELEVATORS.has(head)) return { head, args };
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) i += ELEVATOR_VALUE_FLAGS.has(args[i]) ? 2 : 1;
  return findHead(args.slice(i));
}

/** The subcommand: the first operand that is not a flag or a flag's value. */
function subcommand(args, valueFlags = new Set()) {
  for (let i = 0; i < args.length; i++) {
    if (valueFlags.has(args[i])) i++;
    else if (!args[i].startsWith("-")) return { verb: args[i], index: i };
  }
  return { verb: null, index: -1 };
}

/** Why this command schedules or enables something, or null when it does not. */
function persistenceCommand(head, args) {
  const has = (...flags) => args.some((a) => flags.includes(a));
  if (head === "crontab") {
    const listing = has("-l", "-V", "--help") && !has("-e", "-r");
    return listing ? null : "crontab edit or install";
  }
  if (head === "at" || head === "batch") {
    const reading = head === "at" && has("-l", "-c", "-d", "-r", "-V");
    return reading ? null : `${head} schedules a job`;
  }
  if (head === "launchctl") {
    const { verb, index } = subcommand(args);
    // `launchctl asuser 501 launchctl load …` runs the rest as a command.
    if (verb === "asuser") {
      const inner = findHead(args.slice(index + 2));
      return persistenceCommand(inner.head, inner.args);
    }
    return LAUNCHCTL_INSTALL.has(verb) ? `launchctl ${verb}` : null;
  }
  if (head === "systemctl") {
    const { verb } = subcommand(args, SYSTEMD_VALUE_FLAGS);
    return SYSTEMCTL_INSTALL.has(verb) ? `systemctl ${verb}` : null;
  }
  if (head === "loginctl") {
    const { verb } = subcommand(args, SYSTEMD_VALUE_FLAGS);
    return verb === "enable-linger" ? "loginctl enable-linger" : null;
  }
  return null;
}

/**
 * A shape for one segment. `writes` are the paths the segment writes to, found
 * by the caller; `context` carries the working directory for resolving them.
 */
export function persistenceShape(head, args, writes, context = {}) {
  const real = underElevation(head, args);
  const command = persistenceCommand(real.head, real.args);
  if (command) return { id: "persistence", detail: command, targets: [] };
  const path = writes.find((w) => isPersistencePath(w, context.cwd, context.resolvePath));
  return path
    ? { id: "persistence", detail: `write to ${String(path).trim()}`, targets: [] }
    : null;
}
