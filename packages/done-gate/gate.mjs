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

import { repoRelativePath } from "../../shared/paths.mjs";
import { CMD_START, RUNNER, standalone, isVerifyCommand } from "../../shared/check-command.mjs";
import { logText } from "./evidence.mjs";

const EDIT_TOOLS = new Set(["edit", "write"]);

// Prose edits do not need a test run; a README tweak is not unverified code.
const DOC_FILE = /\.(md|mdx|markdown|txt|rst|adoc)$/i;

// Checks that compile or lint without running the changed code. They show the code builds;
// a test, `.pi/verify` or a bigger gate such as `npm run check` is what runs it.
// `stylua --check` and `selene` are not listed: they are the only checks the gate maps
// for Lua, so there is no test runner to ask for instead.
const STATIC_COMMANDS = [
  String.raw`(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:lint|typecheck)\b`,
  String.raw`go\s+vet\b`,
  String.raw`deno\s+(?:check|lint)\b`,
  String.raw`cargo\s+(?:check|clippy)\b`,
  String.raw`${RUNNER}(?:tsc|mypy|ruff|oxlint|eslint|golangci-lint)\b`,
].map((body) => new RegExp(CMD_START + body));

/**
 * "static" for a compile or lint check, "behavior" for any other check, null for
 * a command that is not a recognised check at all.
 */
export function checkKind(command) {
  if (!isVerifyCommand(command)) return null;
  return STATIC_COMMANDS.some((pattern) => pattern.test(command.trim())) ? "static" : "behavior";
}

// Where compiling or linting is the change itself: type declarations, and the
// config the compiler or linter reads.
const STATIC_FILE =
  /(?:^|\/)(?:[^/]+\.d\.[cm]?ts|tsconfig[^/]*\.json|\.?eslint(?:rc|\.config)[^/]*|\.oxlintrc[^/]*|\.oxfmtrc[^/]*|\.golangci\.[a-z]+|\.?stylua\.toml|selene\.toml|ruff\.toml|mypy\.ini|biome\.jsonc?)$/;

/** True when every path is one a compile or lint run fully covers. */
export function staticIsEnough(paths) {
  const list = [...paths];
  return list.length > 0 && list.every((path) => STATIC_FILE.test(String(path)));
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
    // A passed check that runs the code, since the last edit. A typecheck alone is not.
    behaviorVerified: false,
    // A passing test run that did not reach the edits: { command, why: "no" | "unknown" }.
    testGap: null,
    remoteVerificationSeen: false,
    remoteNudged: false,
    // Every check seen this input, oldest first, for reading a "tests passed" claim against.
    runs: [],
    claimGapNudged: false,
  };
}

export function resetGateState(state) {
  return Object.assign(state, createGateState());
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
  { toolName, input, isError, cwd, before, after, content, coverage } = {},
) {
  if (EDIT_TOOLS.has(toolName)) {
    const raw = typeof input?.path === "string" ? input.path : undefined;
    // The nudge asks for the repo's checks, so only files those checks can cover
    // count: a `/tmp` probe or a home dotfile is not one. No cwd, no filtering.
    const path = raw ? repoRelativePath(cwd, raw) : null;
    if (isError !== true && path && !DOC_FILE.test(path)) {
      invalidateEvidence(state, null);
      state.behaviorVerified = false;
      state.testGap = null;
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
    let status = "unknown";
    if (isError === true) status = "failed";
    else if (isError === false && sameRevision(before, after)) status = "passed";
    state.verificationStatus = status;
    state.verificationSeen = status === "passed";
    state.verificationRevision = status === "passed" ? after : null;
    recordRun(state, { command: input.command, status, log: logText(content) });
    if (status === "passed")
      clearForPass(state, checkKind(input?.command), { command: input.command, coverage });
    else for (const path of state.edited) state.dirty.add(path);
  }
}

const MAX_RUNS = 8;

/** Remember one check for the tests-passed claim check; the newest few are kept. */
function recordRun(state, { command, status, log }) {
  state.runs ??= [];
  state.runs.push({ command, kind: checkKind(command), status, log });
  if (state.runs.length > MAX_RUNS) state.runs.shift();
}

/**
 * A pass clears the edits it covers. A compile or lint pass covers them only for
 * a change to types or to that setup, or when a run that executes the code has
 * already passed on this tree; otherwise the edits stay unverified.
 *
 * A test run counts only when it reached a changed file. `coverage` is the
 * caller's reading of that: "no" and "unknown" leave the edits unverified and
 * remember why, anything else (including not judged) counts.
 */
function clearForPass(state, kind, { command, coverage } = {}) {
  if (kind !== "static") {
    if (coverage === "no" || coverage === "unknown") {
      if (!state.behaviorVerified) state.testGap = { command, why: coverage };
    } else {
      state.behaviorVerified = true;
      state.testGap = null;
    }
  }
  if (state.behaviorVerified || staticIsEnough(state.edited)) state.dirty.clear();
  else for (const path of state.edited) state.dirty.add(path);
}

/** A check the user ran with `!` that passed cleanly on the tree as it is now. */
export function observeUserCheck(state, revision, run) {
  state.verificationStatus = "passed";
  state.verificationSeen = true;
  state.verificationRevision = revision;
  if (run?.command) {
    recordRun(state, { command: run.command, status: "passed", log: logText(run.output) });
  }
  clearForPass(state, checkKind(run?.command) ?? "behavior", run ?? {});
}

/** Edits, shell writes and external changes after a check invalidate its evidence. */
export function invalidateEvidence(state, revision) {
  if (state.verificationSeen && !sameRevision(state.verificationRevision, revision)) {
    state.verificationSeen = false;
    state.behaviorVerified = false;
    state.testGap = null;
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

const PATH_ITSELF = "run the changed path itself (the command, request or screen it serves),";

function checkSentence(commands, staticOnly = false, gap = null) {
  if (gap?.why === "unknown") {
    return `Before reporting done, run the tests again and name them in the command (for example \`node --test path/to/x.test.mjs\`) so it is clear which files ran, or ${PATH_ITSELF}`;
  }
  if (gap)
    return `Before reporting done, run a test that imports or names the changed code, or ${PATH_ITSELF}`;
  if (staticOnly) {
    // The typecheck already ran: name only the checks that execute code.
    const running = Array.isArray(commands)
      ? commands.filter((command) => checkKind(command) === "behavior")
      : [];
    if (running.length === 0) {
      return "Before reporting done, run a test that reaches the changed code, or run the changed path itself (the command, request or screen it serves),";
    }
    commands = running;
  }
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
  const gap = state.verificationSeen && !state.behaviorVerified ? state.testGap : null;
  const staticOnly = state.verificationSeen && !state.behaviorVerified && !gap;
  let doneLine;
  if (gap) {
    const why =
      gap.why === "unknown"
        ? `the gate could not tell which test files \`${gap.command}\` ran`
        : "no test file it ran imports or names the changed files";
    doneLine = `Done check: ${files.length} file(s) changed (${list(files)}). \`${gap.command}\` passed, but ${why}, so it does not show the changed code ran.`;
  } else if (staticOnly) {
    doneLine = `Done check: ${files.length} file(s) changed and only compile or lint checks ran after the last edit (${list(files)}). That shows the code builds, not that the changed path ran.`;
  } else {
    doneLine = `Done check: ${files.length} file(s) changed after the last verification run (${list(files)}).`;
  }
  const lines = [
    doneLine,
    checkSentence(commands, staticOnly, gap),
    "or say plainly why verification does not apply.",
    "Then close with your explanation of the work plus one line to name the check that reached the changed code and what it showed,",
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
