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
  isVerifyCommand,
  observeToolResult,
  resetGateState,
  shouldNudge,
} from "../gate.mjs";

const edit = (path, isError = false) => ({ toolName: "edit", input: { path }, isError });
const bash = (command) => ({ toolName: "bash", input: { command }, isError: false });

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
    "cd packages/foo && npm test",
    "CI=1 npm test",
    "npm run build; npm test",
  ]) {
    assert.equal(isVerifyCommand(command), true, command);
  }
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

test("verification after the last edit clears the gate, even when the check fails", () => {
  const state = createGateState();
  observeToolResult(state, edit("src/a.ts"));
  observeToolResult(state, { ...bash("npm test"), isError: true });
  assert.equal(shouldNudge(state, "completed"), false);

  observeToolResult(state, edit("src/b.ts"));
  assert.equal(shouldNudge(state, "completed"), true, "an edit after the check re-arms it");
  assert.deepEqual([...state.dirty], ["src/b.ts"]);
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
