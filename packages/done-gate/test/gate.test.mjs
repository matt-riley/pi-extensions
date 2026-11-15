import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DIFF_ARGS,
  buildNudge,
  checkKind,
  createGateState,
  debugTagsInDiff,
  debugTagsInFile,
  isRemoteVerifyCommand,
  isVerifyCommand,
  invalidateEvidence,
  livePaths,
  observeToolResult,
  observeUserCheck,
  staticIsEnough,
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

test("checkKind separates compile and lint checks from checks that run the code", () => {
  for (const command of [
    "tsc --noEmit",
    "npx tsc -p tsconfig.json",
    "npx eslint src",
    "oxlint --deny-warnings .",
    "ruff check .",
    "mypy src",
    "go vet ./...",
    "cargo check",
    "cargo clippy",
    "golangci-lint run",
    "npm run lint",
    "pnpm typecheck",
    "rtk npm run typecheck",
  ]) {
    assert.equal(checkKind(command), "static", command);
  }
  for (const command of [
    "npm test",
    "npm run check",
    "node --test packages/foo/test",
    "go test ./...",
    "cargo test",
    "pytest -q",
    "vitest run",
    "make test",
    ".pi/verify",
    "rtk npm test",
    // The only checks mapped for Lua: nothing runs the code, so they stand as the check.
    "stylua --check lua",
    "selene lua",
  ]) {
    assert.equal(checkKind(command), "behavior", command);
  }
  for (const command of ["ls -la", "grep 'npm test' notes.txt", "npm test && echo ok", undefined]) {
    assert.equal(checkKind(command), null, String(command));
  }
});

test("staticIsEnough only when the change is to types or to the compile and lint setup itself", () => {
  assert.equal(staticIsEnough(["types/api.d.ts"]), true);
  assert.equal(staticIsEnough(["tsconfig.json", "packages/a/tsconfig.build.json"]), true);
  assert.equal(staticIsEnough([".oxlintrc.json", "eslint.config.js", ".golangci.yml"]), true);
  assert.equal(staticIsEnough(["tsconfig.json", "src/a.ts"]), false);
  assert.equal(staticIsEnough(["src/a.ts"]), false);
  assert.equal(staticIsEnough([]), false);
});

test("a typecheck alone does not clear a code edit: it shows the code builds, not that it ran", () => {
  const state = createGateState();
  observeToolResult(state, edit("src/a.ts"));
  observeToolResult(state, bash("tsc --noEmit"));
  assert.equal(state.verificationStatus, "passed");
  assert.equal(shouldNudge(state, "completed"), true);
  const text = buildNudge(state);
  assert.match(text, /only compile or lint checks ran/i);
  assert.match(text, /src\/a\.ts/);
  assert.doesNotMatch(text, /tsc/);
});

test("a check that runs the code clears the edit, and a later typecheck does not undo it", () => {
  const state = createGateState();
  observeToolResult(state, edit("src/a.ts"));
  observeToolResult(state, bash("tsc --noEmit"));
  observeToolResult(state, bash("npm test"));
  assert.equal(shouldNudge(state, "completed"), false);
  observeToolResult(state, bash("tsc --noEmit"));
  assert.equal(shouldNudge(state, "completed"), false);
});

test("an edit after a passing test run needs a new run that executes the code", () => {
  const state = createGateState();
  observeToolResult(state, edit("src/a.ts"));
  observeToolResult(state, bash("npm test"));
  observeToolResult(state, edit("src/b.ts"));
  observeToolResult(state, bash("oxlint ."));
  assert.equal(shouldNudge(state, "completed"), true);
  assert.match(buildNudge(state), /only compile or lint checks ran/i);
});

test("a typecheck is enough when the edit was to types or to the compile setup", () => {
  for (const path of ["types/api.d.ts", "tsconfig.json", ".oxlintrc.json"]) {
    const state = createGateState();
    observeToolResult(state, edit(path));
    observeToolResult(state, bash("tsc --noEmit"));
    assert.equal(shouldNudge(state, "completed"), false, path);
  }
});

test("a failed typecheck still reads as failed, not as compile-only", () => {
  const state = createGateState();
  observeToolResult(state, edit("src/a.ts"));
  observeToolResult(state, { ...bash("tsc --noEmit"), isError: true });
  assert.match(buildNudge(state), /Verification status: failed/);
  assert.doesNotMatch(buildNudge(state), /only compile or lint/i);
});

test("a typecheck the user ran with ! is compile-only too, a test run clears the edit", () => {
  const typed = createGateState();
  observeToolResult(typed, edit("src/a.ts"));
  observeUserCheck(typed, revision, { command: "npm run lint", output: "ok" });
  assert.equal(shouldNudge(typed, "completed"), true);
  const tested = createGateState();
  observeToolResult(tested, edit("src/a.ts"));
  observeUserCheck(tested, revision, { command: "npm test", output: "ok" });
  assert.equal(shouldNudge(tested, "completed"), false);
});

test("the nudge asks which check reached the changed code", () => {
  const state = createGateState();
  observeToolResult(state, edit("src/a.ts"));
  assert.match(buildNudge(state), /name the check that reached the changed code/i);
});

test("a test run that reached none of the changed files does not clear them", () => {
  const state = createGateState();
  observeToolResult(state, edit("src/a.ts"));
  observeToolResult(state, { ...bash("node --test test/b.test.mjs"), coverage: "no" });
  assert.equal(state.verificationStatus, "passed");
  assert.equal(shouldNudge(state, "completed"), true);
  const text = buildNudge(state);
  assert.match(text, /`node --test test\/b\.test\.mjs` passed/);
  assert.match(text, /no test file it ran imports or names the changed files/i);
  assert.match(text, /src\/a\.ts/);
  assert.match(text, /run the changed path itself/i);
  assert.doesNotMatch(text, /only compile or lint/i);
});

test("a run whose test files cannot be told says so, and still asks for the changed path", () => {
  const state = createGateState();
  observeToolResult(state, edit("src/a.ts"));
  observeToolResult(state, { ...bash("go test ./..."), coverage: "unknown" });
  assert.equal(shouldNudge(state, "completed"), true);
  const text = buildNudge(state);
  assert.match(text, /could not tell which test files `go test \.\/\.\.\.` ran/i);
  assert.match(text, /name them in the command/i);
});

test("a test run that reached a changed file clears the edits", () => {
  const state = createGateState();
  observeToolResult(state, edit("src/a.ts"));
  observeToolResult(state, { ...bash("node --test test/a.test.mjs"), coverage: "yes" });
  assert.equal(shouldNudge(state, "completed"), false);
});

test("a later run that does reach the change clears what an unrelated one left", () => {
  const state = createGateState();
  observeToolResult(state, edit("src/a.ts"));
  observeToolResult(state, { ...bash("node --test test/b.test.mjs"), coverage: "no" });
  observeToolResult(state, { ...bash("node --test test/a.test.mjs"), coverage: "yes" });
  assert.equal(shouldNudge(state, "completed"), false);
});

test("a covering run is undone by a later edit like any other evidence", () => {
  const state = createGateState();
  observeToolResult(state, edit("src/a.ts"));
  observeToolResult(state, { ...bash("node --test test/a.test.mjs"), coverage: "yes" });
  observeToolResult(state, edit("src/c.ts"));
  assert.equal(shouldNudge(state, "completed"), true);
  assert.doesNotMatch(buildNudge(state), /imports or names/i);
});

test("a run nobody judged for coverage keeps counting, as before", () => {
  const state = createGateState();
  observeToolResult(state, edit("src/a.ts"));
  observeToolResult(state, bash("node --test"));
  assert.equal(shouldNudge(state, "completed"), false);
});

test("a test run the user ran with ! is judged for coverage too", () => {
  const state = createGateState();
  observeToolResult(state, edit("src/a.ts"));
  observeUserCheck(state, revision, {
    command: "node --test test/b.test.mjs",
    output: "ok",
    coverage: "no",
  });
  assert.equal(shouldNudge(state, "completed"), true);
  assert.match(buildNudge(state), /imports or names/i);
});

test("common runner and script names are recognised as checks", () => {
  for (const command of [
    "deno test",
    "deno test -A --coverage",
    "rtk deno test",
    "deno check main.ts",
    "deno lint",
    "./scripts/test.sh",
    "scripts/test.sh",
    "bash scripts/test.sh",
    "sh ./scripts/check.sh",
    "./scripts/verify.sh --all",
    "npm run smoke",
    "pnpm smoke",
    "rtk npm run smoke",
    "npm run check",
    "npm run test:unit",
    "npm run check:types",
    "dotnet test",
    "mvn test",
    "./gradlew test",
    "bundle exec rspec",
    "phpunit",
    "npx mocha",
    "npx playwright test",
  ])
    assert.equal(isVerifyCommand(command), true, command);
});

test("a check with its output redirected is still a standalone check", () => {
  for (const command of [
    "npm run check 2>&1",
    "npm run check > /tmp/check.log 2>&1",
    "node --test &> /tmp/out",
    "npm test 2>/dev/null",
  ])
    assert.equal(isVerifyCommand(command), true, command);
  // A pipe or a chain can hide the check's exit status, so these stay out.
  for (const command of [
    "npm run check 2>&1 | tail -5",
    "npm run check; echo done",
    "npm test || true",
    "npm run build",
    "./scripts/deploy.sh",
    "bash scripts/build.sh",
    "npm run smoke:publish",
  ])
    assert.equal(isVerifyCommand(command), false, command);
});

test("deno check and deno lint only compile or lint; deno test and the scripts run code", () => {
  assert.equal(checkKind("deno check main.ts"), "static");
  assert.equal(checkKind("deno lint"), "static");
  assert.equal(checkKind("deno test"), "behavior");
  assert.equal(checkKind("npm run smoke"), "behavior");
  assert.equal(checkKind("./scripts/test.sh"), "behavior");
});
