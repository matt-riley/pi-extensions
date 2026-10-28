import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DIFF_ARGS,
  buildNudge,
  createGateState,
  debugTagsInDiff,
  debugTagsInFile,
  isRemoteVerifyCommand,
  isVerifyCommand,
  invalidateEvidence,
  livePaths,
  observeToolResult,
  observeToolStart,
  resetGateState,
  shouldNudge,
} from "../gate.mjs";

const edit = (path, isError = false) => ({ toolName: "edit", input: { path }, isError });
const revision = { head: "abc123", fingerprint: "tree-1", clean: true };
const bash = (command) => ({
  toolName: "bash",
  input: { command },
  isError: false,
  before: revision,
  after: revision,
});

test("recognizes verification commands in command position", () => {
  for (const command of [
    "npm test",
    "npm run check",
    "pnpm lint",
    "bun run typecheck",
    "node --test 'packages/**/*.test.mjs'",
    "go test ./...",
    "cargo clippy",
    "make check",
    "npx tsc --noEmit",
    "pytest -q",
    "uv run pytest",
    "python -m pytest tests",
    ".pi/verify",
    "bash .pi/verify/run.sh",
    "rtk npm test",
    "CI=1 npm test",
    "CI=1 rtk npm run check",
  ]) {
    assert.equal(isVerifyCommand(command), true, command);
  }
});

test("a successful stylua --check after the edit counts as verification", () => {
  assert.equal(isVerifyCommand("stylua --check plugin/init.lua"), true);
  assert.equal(isVerifyCommand("npx stylua --check plugin/init.lua"), true);
  assert.equal(isVerifyCommand("stylua plugin/init.lua"), false);
  assert.equal(isVerifyCommand("stylua --check plugin/init.lua && selene plugin/init.lua"), false);

  const state = createGateState();
  observeToolResult(state, edit("plugin/init.lua"));
  observeToolResult(state, bash("stylua --check plugin/init.lua"));
  assert.equal(state.verificationStatus, "passed");
  assert.equal(shouldNudge(state, "completed"), false);
});

test("a successful selene run after the edit counts as verification", () => {
  assert.equal(isVerifyCommand("selene plugin/init.lua plugin/util.lua"), true);
  assert.equal(isVerifyCommand("selene --help"), false);

  const state = createGateState();
  observeToolResult(state, edit("plugin/init.lua"));
  observeToolResult(state, bash("selene plugin/init.lua"));
  assert.equal(state.verificationStatus, "passed");
  assert.equal(shouldNudge(state, "completed"), false);
});

test("does not mistake reads or searches for verification", () => {
  for (const command of [
    'grep -rn "npm test" README.md',
    "cat tsconfig.json",
    "cat .pi/verify/SKILL.md",
    "ls node_modules/.bin/eslint",
    "npm install",
    "git status",
    "echo pytest",
    "false && npm test",
    "npm test || true",
    "npm test; echo done",
    "npm test &",
    "npm test | cat",
    "echo $(npm test)",
    "cd missing && npm test",
    "npm test -- --listTests",
    undefined,
  ]) {
    assert.equal(isVerifyCommand(command), false, String(command));
  }
});

test("a code edit with no later verification nudges once", () => {
  const state = createGateState();
  observeToolResult(state, edit("src/a.ts"));
  assert.equal(shouldNudge(state, "completed"), true);

  const text = buildNudge(state);
  assert.match(
    text,
    /^Done check: 1 file\(s\) changed after the last verification run \(src\/a\.ts\)\./,
  );
  assert.equal(shouldNudge(state, "completed"), false, "at most one nudge per run");
});

test("a failed check stays unverified; only a successful final-revision check clears the gate", () => {
  const state = createGateState();
  observeToolResult(state, edit("src/a.ts"));
  observeToolResult(state, { ...bash("npm test"), isError: true });
  assert.equal(shouldNudge(state, "completed"), true);
  assert.equal(state.verificationSeen, false);
  assert.equal(state.verificationStatus, "failed");
  observeToolResult(state, bash("npm test"));
  assert.equal(shouldNudge(state, "completed"), false);
  assert.equal(state.verificationStatus, "passed");

  observeToolResult(state, edit("src/b.ts"));
  assert.equal(shouldNudge(state, "completed"), true, "an edit after the check re-arms it");
  assert.deepEqual([...state.dirty], ["src/a.ts", "src/b.ts"]);
  assert.equal(state.verificationSeen, false);
});

test("doc edits, failed edits and non-verify bash leave the gate clean", () => {
  const state = createGateState();
  observeToolResult(state, edit("README.md"));
  observeToolResult(state, edit("docs/guide.MDX"));
  observeToolResult(state, edit("src/a.ts", true));
  observeToolResult(state, bash("ls"));
  assert.equal(shouldNudge(state, "completed"), false);
});

test("aborted or errored runs are not nudged", () => {
  const state = createGateState();
  observeToolResult(state, edit("src/a.ts"));
  assert.equal(shouldNudge(state, "aborted"), false);
  assert.equal(shouldNudge(state, "error"), false);
  assert.equal(shouldNudge(state, undefined), true);
});

test("reset clears dirty paths and re-arms the nudge", () => {
  const state = createGateState();
  observeToolResult(state, edit("src/a.ts"));
  buildNudge(state);
  resetGateState(state);
  assert.equal(shouldNudge(state, "completed"), false);
  observeToolResult(state, edit("src/a.ts"));
  assert.equal(shouldNudge(state, "completed"), true);
});

test("the nudge lists debug hits and truncates long lists", () => {
  const state = createGateState();
  for (const name of ["a", "b", "c", "d", "e", "f", "g"]) {
    observeToolResult(state, edit(`src/${name}.ts`));
  }
  const text = buildNudge(state, ["src/a.ts:3"]);
  assert.match(text, /7 file\(s\)/);
  assert.match(text, /src\/e\.ts and 2 more\)/);
  assert.match(text, /Leftover debug instrumentation to remove: src\/a\.ts:3\./);
});

test("finds debug tags on added diff lines with their new line numbers", () => {
  const dir = mkdtempSync(join(tmpdir(), "done-gate-"));
  try {
    const git = (...args) =>
      execFileSync("git", ["-C", dir, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
    git("init", "-q");
    git("config", "user.email", "test@example.com");
    git("config", "user.name", "test");
    writeFileSync(join(dir, "a.js"), "one\ntwo\nthree\nfour\n");
    writeFileSync(join(dir, "old.js"), "console.log('[DEBUG-old] committed');\n");
    git("add", ".");
    git("commit", "-q", "-m", "base");

    writeFileSync(
      join(dir, "a.js"),
      "one\nconsole.log('[DEBUG-a4f2] x');\ntwo\nthree\nfour\nconsole.log('[DEBUG-a4f2] y');\n",
    );
    const diff = git(...DIFF_ARGS);
    assert.deepEqual(
      debugTagsInDiff(diff),
      ["a.js:2", "a.js:6"],
      "committed tags are not reported",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ignores removed lines and deleted files", () => {
  const diff = [
    "diff --git a/gone.js b/gone.js",
    "--- a/gone.js",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-console.log('[DEBUG-x]');",
  ].join("\n");
  assert.deepEqual(debugTagsInDiff(diff), []);
});

test("finds debug tags in a whole untracked file", () => {
  assert.deepEqual(debugTagsInFile("new.py", "a\nprint('[DEBUG-9] b')\nc"), ["new.py:2"]);
  assert.deepEqual(debugTagsInFile("clean.py", "a\nb"), []);
});

test("a verification command is remembered for the claim judgment", () => {
  const state = createGateState();
  assert.equal(state.verificationSeen, false, "a fresh run has seen no check");
  observeToolResult(state, bash("npm test"));
  assert.equal(state.verificationSeen, true);
  resetGateState(state);
  assert.equal(state.verificationSeen, false, "the next run starts over");
});

test("the nudge carries a claim judgment, and nothing when there is none", () => {
  const state = createGateState();
  observeToolResult(state, edit("src/a.ts"));
  const judged = buildNudge(state, [], "TypeSafe reads that claim as done.");
  assert.match(judged, /Done check: 1 file\(s\) changed/);
  assert.match(judged, /TypeSafe reads that claim as done\.$/);

  const quiet = createGateState();
  observeToolResult(quiet, edit("src/a.ts"));
  assert.doesNotMatch(buildNudge(quiet), /TypeSafe/);
});

test("edits outside the session cwd do not arm the gate", () => {
  const state = createGateState();
  const cwd = "/work/repo";
  observeToolResult(state, { ...edit("/tmp/probe.mjs"), cwd });
  observeToolResult(state, { ...edit("../other/src/a.ts"), cwd });
  observeToolResult(state, { ...edit("/Users/someone/.pi/agent/settings.json"), cwd });
  assert.equal(shouldNudge(state, "completed"), false, "outside paths are not the repo's to check");

  observeToolResult(state, { ...edit("/work/repo/src/a.ts"), cwd });
  assert.deepEqual(
    [...state.dirty],
    ["src/a.ts"],
    "an absolute path inside cwd is stored relative",
  );
});

test("without a cwd every edit still arms the gate", () => {
  const state = createGateState();
  observeToolResult(state, edit("/tmp/probe.mjs"));
  assert.deepEqual([...state.dirty], ["/tmp/probe.mjs"]);
});

test("only edits the working tree still carries are gated", () => {
  assert.deepEqual(livePaths(["src/a.ts", "src/b.ts"], ["src/b.ts", "new.ts"]), ["src/b.ts"]);
  assert.deepEqual(livePaths(["./src/a.ts"], ["src/a.ts"]), ["./src/a.ts"]);
  assert.deepEqual(livePaths(["src/a.ts"], []), [], "a reverted edit is not gated");
  assert.deepEqual(livePaths(["src/a.ts"], null), ["src/a.ts"], "an unknown tree keeps the gate");
});

test("the nudge asks for the explanation back, not a report about the reminder", () => {
  const state = createGateState();
  observeToolResult(state, edit("src/a.ts"));
  assert.match(buildNudge(state), /close with your explanation of the work/);
});

test("the nudge names the scoped commands instead of a generic check", () => {
  const state = createGateState();
  observeToolResult(state, edit("pkg/foo/a.go"));
  const text = buildNudge(state, [], null, ["go test ./pkg/foo", "golangci-lint run ./pkg/foo"]);
  assert.match(
    text,
    /run `go test \.\/pkg\/foo` and `golangci-lint run \.\/pkg\/foo` as separate commands, and exercise the changed behavior/,
  );
  assert.match(text, /close with your explanation of the work/);
  assert.match(text, /Verification status: unknown/);
  assert.doesNotMatch(text, /run the repo's checks/);
});

test("only a successful remote check counts as remote evidence", () => {
  const state = createGateState();
  assert.equal(state.remoteVerificationSeen, false);
  observeToolResult(state, { ...bash("gh pr checks 42"), isError: true });
  assert.equal(state.remoteVerificationSeen, false, "a failing check is not CI green");
  observeToolResult(state, bash("gh pr checks 42"));
  assert.equal(state.remoteVerificationSeen, false, "command success alone is not remote evidence");
  observeToolResult(state, {
    ...bash("gh pr view 42 --json headRefOid,statusCheckRollup"),
    content: [
      {
        type: "text",
        text: JSON.stringify({
          headRefOid: revision.head,
          statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
        }),
      },
    ],
  });
  assert.equal(state.remoteVerificationSeen, true);
  resetGateState(state);
  assert.equal(state.remoteVerificationSeen, false, "the next run starts over");
});

test("a started check is only attempted until an unchanged-revision result succeeds", () => {
  const state = createGateState();
  observeToolStart(state, bash("npm test"));
  assert.equal(state.verificationStatus, "attempted");
  assert.equal(state.verificationSeen, false);
  observeToolResult(state, bash("npm test"));
  assert.equal(state.verificationStatus, "passed");
  observeToolStart(state, bash("gh pr checks 42"));
  assert.equal(state.remoteVerificationStatus, "attempted");
  assert.equal(state.remoteVerificationSeen, false);
  assert.equal(state.verificationSeen, true);
});

test("revision changes, unknown identity and failed later checks invalidate earlier success", () => {
  const state = createGateState();
  observeToolResult(state, edit("src/a.ts"));
  observeToolResult(state, { ...bash("npm test"), after: { ...revision, fingerprint: "tree-2" } });
  assert.equal(state.verificationSeen, false);
  assert.equal(state.verificationStatus, "unknown");
  observeToolResult(state, { ...bash("npm test"), before: null });
  assert.equal(state.verificationSeen, false);
  observeToolResult(state, bash("npm test"));
  invalidateEvidence(state, { ...revision, fingerprint: "tree-3" });
  assert.equal(state.verificationSeen, false);
  assert.deepEqual([...state.dirty], ["src/a.ts"]);
  observeToolResult(state, bash("npm test"));
  observeToolResult(state, { ...bash("npm test"), isError: true });
  assert.equal(state.verificationSeen, false);
  assert.deepEqual([...state.dirty], ["src/a.ts"]);
});

test("remote evidence requires nonempty successful checks, matching HEAD, and a clean unchanged tree", () => {
  const command = "rtk gh pr view 42 --json headRefOid,statusCheckRollup";
  for (const [rollup, head, after, isError] of [
    [[], revision.head, revision, false],
    [[{ status: "IN_PROGRESS", conclusion: null }], revision.head, revision, false],
    [[{ status: "COMPLETED", conclusion: "FAILURE" }], revision.head, revision, false],
    [[{ status: "COMPLETED", conclusion: "SKIPPED" }], revision.head, revision, false],
    [[{ state: "SUCCESS" }], "different-head", revision, false],
    [[{ state: "SUCCESS" }], revision.head, { ...revision, clean: false }, false],
    [[{ state: "SUCCESS" }], revision.head, { ...revision, fingerprint: "tree-2" }, false],
    [[{ state: "SUCCESS" }], revision.head, revision, true],
  ]) {
    const state = createGateState();
    observeToolResult(state, {
      ...bash(command),
      after,
      isError,
      content: [
        { type: "text", text: JSON.stringify({ headRefOid: head, statusCheckRollup: rollup }) },
      ],
    });
    assert.equal(
      state.remoteVerificationSeen,
      false,
      JSON.stringify({ rollup, head, after, isError }),
    );
  }
  const state = createGateState();
  observeToolResult(state, { ...bash(command), content: [{ type: "text", text: "not JSON" }] });
  assert.equal(state.remoteVerificationStatus, "unknown");
});

test("remote checks are recognized in command position only", () => {
  for (const command of [
    "gh pr checks",
    "gh pr checks 42 --watch",
    "gh run view 123 --log-failed",
    "gh run list --limit 5",
    "gh pr view 42 --json statusCheckRollup",
  ]) {
    assert.equal(isRemoteVerifyCommand(command), true, command);
  }
  for (const command of [
    'grep -rn "gh pr checks" README.md',
    "echo gh pr checks",
    "git push origin main",
    "npm test",
    undefined,
  ]) {
    assert.equal(isRemoteVerifyCommand(command), false, String(command));
  }
});
