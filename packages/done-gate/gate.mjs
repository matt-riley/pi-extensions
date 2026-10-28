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
import { hasCommandSubstitution, splitSegments } from "../../shared/shell-parse.mjs";

const EDIT_TOOLS = new Set(["edit", "write"]);

// Prose edits do not need a test run; a README tweak is not unverified code.
const DOC_FILE = /\.(md|mdx|markdown|txt|rst|adoc)$/i;

// Only standalone commands have an exit status attributable to the check.
// A compound shell can skip a check or hide its failure behind a later success.
const CMD_START = String.raw`^(?:[A-Z_][A-Z0-9_]*=\S*\s+)*(?:rtk\s+)?`;
const RUNNER = String.raw`(?:(?:npx|bunx|pnpm\s+exec|pnpm\s+dlx|uv\s+run|python3?\s+-m)\s+)?`;
const VERIFY_COMMANDS = [
  String.raw`(?:bash\s+|sh\s+|node\s+)?(?:\.\/)?\.pi\/verify\b`,
  String.raw`(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|typecheck|verify)\b`,
  String.raw`node\s+--test\b`,
  String.raw`go\s+(?:test|vet)\b`,
  String.raw`cargo\s+(?:test|check|clippy)\b`,
  String.raw`make\s+(?:test|check|lint|verify)\b`,
  String.raw`${RUNNER}(?:pytest|vitest|jest|tsc|mypy|ruff|oxlint|eslint|golangci-lint)\b`,
  // Without --check, stylua rewrites the file. That is not a verification run.
  String.raw`${RUNNER}stylua\s+--check\b`,
  String.raw`${RUNNER}selene\b`,
].map((body) => new RegExp(CMD_START + body));

/** True when a bash command runs the repo's checks (tests, typecheck, lint, .pi/verify). */
export function isVerifyCommand(command) {
  if (typeof command !== "string") {
    return false;
  }
  return (
    standalone(command) &&
    !/\s(?:--help|--version|--dry-run|--collect-only|--listTests|--list|-h)\b/.test(command) &&
    VERIFY_COMMANDS.some((pattern) => pattern.test(command.trim()))
  );
}

function standalone(command) {
  return splitSegments(command).length === 1 && !hasCommandSubstitution(command);
}

const sameRevision = (before, after) =>
  Boolean(
    before?.fingerprint && before.head === after?.head && before.fingerprint === after.fingerprint,
  );

/** Fresh state; reset on each user input so every run is judged on its own. */
export function createGateState() {
  return {
    dirty: new Set(),
    edited: new Set(),
    verificationStatus: "unknown",
    verificationRevision: null,
    remoteVerificationStatus: "unknown",
    remoteVerificationRevision: null,
    nudged: false,
    verificationSeen: false,
    remoteVerificationSeen: false,
    remoteNudged: false,
  };
}

export function resetGateState(state) {
  state.dirty.clear();
  state.edited.clear();
  state.verificationStatus = "unknown";
  state.verificationRevision = null;
  state.remoteVerificationStatus = "unknown";
  state.remoteVerificationRevision = null;
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
  return (
    standalone(command) && REMOTE_VERIFY_COMMANDS.some((pattern) => pattern.test(command.trim()))
  );
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

/** A started check is attempted, not evidence of a pass. */
export function observeToolStart(state, { toolName, input } = {}) {
  if (toolName !== "bash" && toolName !== "terminal_start") return;
  if (isRemoteVerifyCommand(input?.command)) {
    state.remoteVerificationStatus = "attempted";
    state.remoteVerificationSeen = false;
    state.remoteVerificationRevision = null;
  } else if (isVerifyCommand(input?.command)) {
    state.verificationStatus = "attempted";
    state.verificationSeen = false;
    state.verificationRevision = null;
    for (const path of state.edited) state.dirty.add(path);
  }
}

/**
 * Observe one finished tool call.
 *
 * - a successful edit/write to a non-doc file inside the cwd marks that path
 *   unverified, stored relative to the cwd
 * - only an observed success against an unchanged known revision clears paths
 * - failed, skipped/masked, unknown and stale checks never count as passed
 */
export function observeToolResult(
  state,
  { toolName, input, isError, cwd, before, after, content } = {},
) {
  if (EDIT_TOOLS.has(toolName)) {
    const raw = typeof input?.path === "string" ? input.path : undefined;
    const path = raw ? repoRelativePath(cwd, raw) : null;
    if (isError !== true && path && !DOC_FILE.test(path)) {
      invalidateEvidence(state, null);
      state.edited.add(path);
      state.dirty.add(path);
    }
    return;
  }
  if (toolName === "bash" && isRemoteVerifyCommand(input?.command)) {
    let status = "unknown";
    if (isError === true) status = "failed";
    else if (isError === false && sameRevision(before, after) && after.clean === true) {
      // A rollup must include the tested SHA. A list command's exit status
      // and human-readable logs cannot establish CI success for this revision.
      try {
        const data = JSON.parse(
          (content ?? [])
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
        );
        const checks = data.statusCheckRollup;
        if (
          /\bgh\s+pr\s+view\b/.test(input.command) &&
          data.headRefOid === after.head &&
          Array.isArray(checks) &&
          checks.length
        ) {
          if (
            checks.every(
              (check) =>
                check.state === "SUCCESS" ||
                (check.status === "COMPLETED" && check.conclusion === "SUCCESS"),
            )
          )
            status = "passed";
          else if (
            checks.some(
              (check) =>
                ["FAILURE", "ERROR"].includes(check.state) ||
                ["FAILURE", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED"].includes(check.conclusion),
            )
          )
            status = "failed";
        }
      } catch {
        /* Missing/truncated/unstructured output stays unknown. */
      }
    }
    state.remoteVerificationStatus = status;
    state.remoteVerificationSeen = status === "passed";
    state.remoteVerificationRevision = status === "passed" ? after : null;
    return;
  }
  if (toolName === "bash" && isVerifyCommand(input?.command)) {
    const status =
      isError === true
        ? "failed"
        : isError === false && sameRevision(before, after)
          ? "passed"
          : "unknown";
    state.verificationStatus = status;
    state.verificationSeen = status === "passed";
    state.verificationRevision = status === "passed" ? after : null;
    if (status === "passed") state.dirty.clear();
    else for (const path of state.edited) state.dirty.add(path);
  }
}

/** Edits, shell writes and external changes after a check invalidate its evidence. */
export function invalidateEvidence(state, revision) {
  if (state.verificationSeen && !sameRevision(state.verificationRevision, revision)) {
    state.verificationSeen = false;
    state.verificationStatus = "unknown";
    state.verificationRevision = null;
    for (const path of state.edited) state.dirty.add(path);
  }
  if (state.remoteVerificationSeen && !sameRevision(state.remoteVerificationRevision, revision)) {
    state.remoteVerificationSeen = false;
    state.remoteVerificationStatus = "unknown";
    state.remoteVerificationRevision = null;
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

function namedCommands(commands) {
  const quoted = commands.map((command) => `\`${command}\``);
  if (quoted.length === 1) return quoted[0];
  if (quoted.length === 2) return `${quoted[0]} and ${quoted[1]}`;
  return `${quoted.slice(0, -1).join(", ")} and ${quoted.at(-1)}`;
}

function checkSentence(commands) {
  if (!Array.isArray(commands) || commands.length === 0) {
    return "Before reporting done, run the repo's checks (`.pi/verify` if present) and exercise the changed behavior,";
  }
  const named = namedCommands(commands);
  if (commands.length === 1) {
    return `Before reporting done, run ${named} and exercise the changed behavior,`;
  }
  return `Before reporting done, run ${named} as separate commands, and exercise the changed behavior,`;
}

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
export function buildNudge(state, debugHits = [], claimText = null, commands = null) {
  state.nudged = true;
  const files = [...state.dirty];
  const lines = [
    `Done check: ${files.length} file(s) changed after the last verification run (${list(files)}).`,
    checkSentence(commands),
    "or say plainly why verification does not apply.",
    "Then close with your explanation of the work plus one line of what the check proved,",
    "not a report about this reminder.",
    `Verification status: ${state.verificationStatus}.`,
  ];
  if (debugHits.length > 0) {
    lines.push(`Leftover debug instrumentation to remove: ${list(debugHits)}.`);
  }
  if (typeof claimText === "string" && claimText.trim()) {
    lines.push(claimText.trim());
  }
  return lines.join(" ");
}
