// playbook-pin.mjs — `/playbook`: an explicit playbook that stays on.
//
// The judged playbook needs a TypeSafe key and a confident answer, and is
// chosen again at every task boundary. A pin is the user's choice instead: it
// holds across task boundaries until `/playbook auto`, `/playbook off` or the
// session ends, skips the judgment, and works with `/route off` or no key.
// Pin state is per extension instance, so a subagent child (a fresh instance)
// never inherits it; index.ts also ignores it in children.

import { NO_PLAYBOOK, PLAYBOOK_TYPES } from "./playbook.mjs";

/**
 * Parse `/playbook` arguments: empty or `status`, `auto`, `off`, or a type
 * (optionally with the word `pin` before or after it).
 */
export function parsePlaybookArgs(raw, types = PLAYBOOK_TYPES) {
  const words = String(raw ?? "")
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word && word !== "pin");
  if (words.length === 0 || (words.length === 1 && words[0] === "status"))
    return { action: "status" };
  if (words.length === 1 && (words[0] === "auto" || words[0] === "off"))
    return { action: words[0] };
  const type = words.join(" ");
  return types.includes(type) ? { action: "pin", type } : { action: "unknown", type };
}

/**
 * Pin state plus the command's replies. `pinned` is `undefined` for the
 * judgment (auto), `none` for off, or the pinned type.
 */
export function createPlaybookPin({ types = PLAYBOOK_TYPES } = {}) {
  let pinned;
  const describe = (current) => {
    if (pinned === NO_PLAYBOOK)
      return "playbook: off (no playbook, no judgment) · /playbook auto to judge again";
    if (pinned !== undefined) return `playbook: ${pinned} (pinned) · /playbook auto to unpin`;
    const judged = current?.type ? `${current.type} (judged)` : "not judged yet (auto)";
    return `playbook: ${judged} · pin one with /playbook <type>`;
  };
  return {
    get pinned() {
      return pinned;
    },
    reset() {
      pinned = undefined;
    },
    /**
     * Apply `/playbook <args>`. `current` is the playbook held for this task,
     * for the status line. `changed` tells the caller to re-resolve the
     * playbook at the next prompt.
     */
    command(args, current) {
      const parsed = parsePlaybookArgs(args, types);
      if (parsed.action === "status")
        return { changed: false, level: "info", message: describe(current) };
      if (parsed.action === "unknown")
        return {
          changed: false,
          level: "warning",
          message: `playbook: unknown type "${parsed.type}". Known: ${types.join(", ")}, or auto, off`,
        };
      if (parsed.action === "auto") {
        pinned = undefined;
        return {
          changed: true,
          level: "info",
          message: "playbook: auto · the next prompt is judged",
        };
      }
      pinned = parsed.action === "off" ? NO_PLAYBOOK : parsed.type;
      return { changed: true, level: "info", message: describe(current) };
    },
  };
}
