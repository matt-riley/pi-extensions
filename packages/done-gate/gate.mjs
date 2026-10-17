// gate.mjs — the done-gate state machine.
//
// A run that edits code and ends without running the repo's checks is a run
// that is about to report "done" on faith. This tracks edits against
// verification runs and, when the run settles dirty, produces one nudge.
// Plain .mjs so node --test covers it without a TS loader (see AGENTS.md).
//
// It stays quiet by refusing to judge what the repo's checks cannot cover: an
// edit outside the session cwd never arms it, and an edit the working tree no
// longer carries is dropped before the nudge is built.

import { isAbsolute, relative, resolve, sep } from "node:path";

const EDIT_TOOLS = new Set(["edit", "write"]);

// Prose edits do not need a test run; a README tweak is not unverified code.
const DOC_FILE = /\.(md|mdx|markdown|txt|rst|adoc)$/i;

// Each pattern must sit in command position — the start of the command or right
// after a separator — so `grep "npm test" README.md` is not a verification run.
const CMD_START = String.raw`(?:^|[;&|(]\s*)(?:[A-Z_][A-Z0-9_]*=\S*\s+)*`;
const RUNNER = String.raw`(?:(?:npx|bunx|pnpm\s+exec|pnpm\s+dlx|uv\s+run|python3?\s+-m)\s+)?`;
const VERIFY_COMMANDS = [
  String.raw`(?:bash\s+|sh\s+|node\s+)?(?:\.\/)?\.pi\/verify\b`,
  String.raw`(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|typecheck|verify)\b`,
  String.raw`node\s+--test\b`,
  String.raw`go\s+(?:test|vet)\b`,
  String.raw`cargo\s+(?:test|check|clippy)\b`,
  String.raw`make\s+(?:test|check|lint|verify)\b`,
  String.raw`${RUNNER}(?:pytest|vitest|jest|tsc|mypy|ruff|oxlint|eslint|golangci-lint)\b`,
].map((body) => new RegExp(CMD_START + body));

/** True when a bash command runs the repo's checks (tests, typecheck, lint, .pi/verify). */
export function isVerifyCommand(command) {
  if (typeof command !== "string") {
    return false;
  }
  return VERIFY_COMMANDS.some((pattern) => pattern.test(command.trim()));
}

/** Fresh state; reset on each user input so every run is judged on its own. */
export function createGateState() {
  return {
    dirty: new Set(),
    nudged: false,
    verificationSeen: false,
    remoteVerificationSeen: false,
    remoteNudged: false,
  };
}

export function resetGateState(state) {
  state.dirty.clear();
  state.nudged = false;
  state.verificationSeen = false;
  state.remoteVerificationSeen = false;
  state.remoteNudged = false;
  return state;
}

/**
 * Commands that ask a runner what it thinks, as opposed to this machine.
 *
 * Only a successful one is evidence: `gh pr checks` exits non-zero when a
 * check failed or is pending, and that is not the CI-green a claim would be
 * resting on. `git push` is not here at all — a push starts CI, it does not
 * report what CI said.
 */
const REMOTE_VERIFY_COMMANDS = [
  String.raw`gh\s+pr\s+checks\b`,
  String.raw`gh\s+run\s+(?:view|list|watch)\b`,
  String.raw`gh\s+api\b.*\/check-runs\b`,
  String.raw`gh\s+pr\s+view\b.*statusCheckRollup`,
].map((body) => new RegExp(CMD_START + body));

/** True when a bash command asks a remote runner for its result. */
export function isRemoteVerifyCommand(command) {
  if (typeof command !== "string") {
    return false;
  }
  return REMOTE_VERIFY_COMMANDS.some((pattern) => pattern.test(command.trim()));
}

/**
 * The edited path relative to the session cwd, or null when it is outside it.
 *
 * The nudge asks for the repo's checks, so the gate may only track files those
 * checks can cover: a `/tmp` probe or a home dotfile is not one. No cwd means
 * no filtering (tests, and any host that omits the field).
 */
function repoRelativePath(cwd, path) {
  if (typeof cwd !== "string" || !cwd) {
    return path;
  }
  const rel = relative(resolve(cwd), resolve(cwd, path));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return null;
  }
  return rel;
}

/**
 * Observe one finished tool call.
 *
 * - a successful edit/write to a non-doc file inside the cwd marks that path
 *   unverified, stored relative to the cwd
 * - a verification command clears every unverified path, pass or fail: the
 *   model has seen the result either way — and is remembered as
 *   `verificationSeen`, which tells the claim judgment whether any check ran
 */
export function observeToolResult(state, { toolName, input, isError, cwd } = {}) {
  if (EDIT_TOOLS.has(toolName)) {
    const raw = typeof input?.path === "string" ? input.path : undefined;
    const path = raw ? repoRelativePath(cwd, raw) : null;
    if (isError !== true && path && !DOC_FILE.test(path)) {
      state.dirty.add(path);
    }
    return;
  }
  if (toolName === "bash" && isRemoteVerifyCommand(input?.command)) {
    if (isError !== true) {
      state.remoteVerificationSeen = true;
    }
    return;
  }
  if (toolName === "bash" && isVerifyCommand(input?.command)) {
    state.dirty.clear();
    state.verificationSeen = true;
  }
}

/** True when the run should be nudged now: completed, dirty, not yet nudged. */
export function shouldNudge(state, outcome) {
  if (state.nudged || state.dirty.size === 0) {
    return false;
  }
  return outcome === undefined || outcome === "completed";
}

const withoutDotSlash = (path) => String(path).replace(/^\.\//, "");

/**
 * The dirty paths the working tree still has a change for.
 *
 * `changed` is `git diff --name-only --relative HEAD` plus untracked files, so
 * a path in neither was reverted during the run (or is ignored/generated) and
 * there is nothing left to verify. `null` means git could not answer — keep
 * every path rather than silently disabling the gate.
 */
export function livePaths(dirty, changed) {
  if (!Array.isArray(changed)) {
    return [...dirty];
  }
  const live = new Set(changed.map(withoutDotSlash));
  return [...dirty].filter((path) => live.has(withoutDotSlash(path)));
}

const DEBUG_TAG = "[DEBUG-";

// Explicit prefixes: user config (diff.mnemonicPrefix, diff.noprefix) otherwise
// changes `b/` to `w/` or drops it, and paths come out wrong.
export const DIFF_ARGS = [
  "diff",
  "-U0",
  "--no-color",
  "--no-ext-diff",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "HEAD",
];

/**
 * `path:line` for every added line carrying a debug tag in `git diff -U0` output.
 */
export function debugTagsInDiff(diff) {
  const hits = [];
  let path;
  let line = 0;
  for (const text of String(diff ?? "").split("\n")) {
    if (text.startsWith("+++ ")) {
      path = text === "+++ /dev/null" ? undefined : text.slice(4).replace(/^b\//, "");
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (text.startsWith("+")) {
      if (path && text.includes(DEBUG_TAG)) {
        hits.push(`${path}:${line}`);
      }
      line += 1;
    } else if (text.startsWith(" ")) {
      line += 1;
    }
  }
  return hits;
}

/** `path:line` for every line of a whole (untracked) file carrying a debug tag. */
export function debugTagsInFile(path, content) {
  const hits = [];
  String(content ?? "")
    .split("\n")
    .forEach((text, index) => {
      if (text.includes(DEBUG_TAG)) {
        hits.push(`${path}:${index + 1}`);
      }
    });
  return hits;
}

const MAX_LISTED = 5;

const list = (items) =>
  items.length > MAX_LISTED
    ? `${items.slice(0, MAX_LISTED).join(", ")} and ${items.length - MAX_LISTED} more`
    : items.join(", ");

/**
 * The nudge. Marks the state nudged so a run gets at most one.
 *
 * The closing sentence matters as much as the verification request: without it
 * the model answers the reminder instead of restating the work, and the person
 * loses the explanation they were reading.
 *
 * `claimText` is the claim judgment's line when it has one. It goes last,
 * where the model reads it immediately before deciding what to do next.
 */
export function buildNudge(state, debugHits = [], claimText = null) {
  state.nudged = true;
  const files = [...state.dirty];
  const lines = [
    `Done check: ${files.length} file(s) changed after the last verification run (${list(files)}).`,
    "Before reporting done, run the repo's checks (`.pi/verify` if present) and exercise the changed behavior,",
    "or say plainly why verification does not apply.",
    "Then close with your explanation of the work plus one line of what the check proved,",
    "not a report about this reminder.",
  ];
  if (debugHits.length > 0) {
    lines.push(`Leftover debug instrumentation to remove: ${list(debugHits)}.`);
  }
  if (typeof claimText === "string" && claimText.trim()) {
    lines.push(claimText.trim());
  }
  return lines.join(" ");
}
