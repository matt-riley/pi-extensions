// gate.mjs — the done-gate state machine.
//
// A run that edits code and ends without running the repo's checks is a run
// that is about to report "done" on faith. This tracks edits against
// verification runs and, when the run settles dirty, produces one nudge.
// Plain .mjs so node --test covers it without a TS loader (see AGENTS.md).

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
  return { dirty: new Set(), nudged: false };
}

export function resetGateState(state) {
  state.dirty.clear();
  state.nudged = false;
  return state;
}

/**
 * Observe one finished tool call.
 *
 * - a successful edit/write to a non-doc file marks that path unverified
 * - a verification command clears every unverified path, pass or fail: the
 *   model has seen the result either way
 */
export function observeToolResult(state, { toolName, input, isError } = {}) {
  if (EDIT_TOOLS.has(toolName)) {
    const path = typeof input?.path === "string" ? input.path : undefined;
    if (isError !== true && path && !DOC_FILE.test(path)) {
      state.dirty.add(path);
    }
    return;
  }
  if (toolName === "bash" && isVerifyCommand(input?.command)) {
    state.dirty.clear();
  }
}

/** True when the run should be nudged now: completed, dirty, not yet nudged. */
export function shouldNudge(state, outcome) {
  if (state.nudged || state.dirty.size === 0) {
    return false;
  }
  return outcome === undefined || outcome === "completed";
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

/** The nudge. Marks the state nudged so a run gets at most one. */
export function buildNudge(state, debugHits = []) {
  state.nudged = true;
  const files = [...state.dirty];
  const lines = [
    `Done check: ${files.length} file(s) changed after the last verification run (${list(files)}).`,
    "Before reporting done, run the repo's checks (`.pi/verify` if present) and exercise the changed behavior,",
    "or say plainly why verification does not apply.",
  ];
  if (debugHits.length > 0) {
    lines.push(`Leftover debug instrumentation to remove: ${list(debugHits)}.`);
  }
  return lines.join(" ");
}
