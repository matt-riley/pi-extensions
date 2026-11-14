// stalepaths.mjs — file paths in a child's task that do not exist.
//
// A child starts with a blank slate and trusts the paths it is given. A path
// that was renamed or deleted sends it hunting, or worse, inventing. This is a
// plain existence check: no model, no network, and it errs towards silence
// (URLs, globs and paths the task says to create are never flagged).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MAX_STALE = 8;
const PATH_LIKE =
  /(?<![\w/:.@-])((?:\/|\.{1,2}\/|~\/)?(?:[\w@.-]+\/)+[\w@-][\w@.-]*\.[A-Za-z0-9]{1,8})(?::\d+)?(?![\w/])/g;
const DOMAIN_FIRST = /^[\w-]+\.[A-Za-z]{2,}$/;
const CREATES = /\b(create|creates|add|adds|new|write|writes|generate|generates|scaffold)\b/i;

/** The text of the sentence or line that precedes `index`. */
function leadIn(text, index) {
  const before = text.slice(0, index);
  const start = Math.max(before.lastIndexOf("\n"), before.search(/[.!?]\s(?!.*[.!?]\s)/));
  return before.slice(start + 1);
}

/** Paths named in `task` that are missing under `cwd`, as written, at most eight. */
export function findStalePaths(task, cwd) {
  const text = String(task ?? "");
  const stale = [];
  for (const match of text.matchAll(PATH_LIKE)) {
    const written = match[1];
    if (stale.includes(written)) continue;
    if (DOMAIN_FIRST.test(written.split("/")[0])) continue;
    if (CREATES.test(leadIn(text, match.index))) continue;
    const resolved = written.startsWith("~/")
      ? path.join(os.homedir(), written.slice(2))
      : path.resolve(cwd, written);
    if (fs.existsSync(resolved)) continue;
    stale.push(written);
    if (stale.length === MAX_STALE) break;
  }
  return stale;
}
