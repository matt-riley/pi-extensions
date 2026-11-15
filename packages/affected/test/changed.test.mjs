import { test } from "node:test";
import assert from "node:assert/strict";

import { changedFiles } from "../changed.mjs";

function fakeGit(outputs) {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const key = args.slice(2).join(" ");
    const out = outputs[key];
    if (out === undefined) return { code: 1, stdout: "", stderr: "no such command" };
    return { code: 0, stdout: out, stderr: "" };
  };
  return { calls, exec };
}

test("working-tree changes are tracked edits plus untracked files, sorted and unique", async () => {
  const { exec, calls } = fakeGit({
    "diff --name-only -z HEAD": "b.ts\0a.ts\0",
    "ls-files --others --exclude-standard -z": "new.ts\0a.ts\0",
  });
  const result = await changedFiles({ exec, root: "/r" });
  assert.deepEqual(result, { files: ["a.ts", "b.ts", "new.ts"], error: null });
  assert.deepEqual(calls[0].slice(0, 3), ["git", "-C", "/r"]);
});

test("a base ref adds what the branch changed since it forked", async () => {
  const { exec } = fakeGit({
    "diff --name-only -z HEAD": "",
    "ls-files --others --exclude-standard -z": "",
    "diff --name-only -z origin/main...HEAD": "c.ts\0",
  });
  assert.deepEqual((await changedFiles({ exec, root: "/r", base: "origin/main" })).files, ["c.ts"]);
});

test("a base that could be an option or a shell word is refused without running git", async () => {
  const { exec, calls } = fakeGit({});
  for (const base of ["--output=x", "a b", "$(x)", "-x", "a;b"]) {
    const result = await changedFiles({ exec, root: "/r", base });
    assert.match(result.error, /not a usable ref/);
    assert.deepEqual(result.files, []);
  }
  assert.equal(calls.length, 0);
});

test("a git failure is an error, not an empty change set", async () => {
  const { exec } = fakeGit({});
  const result = await changedFiles({ exec, root: "/r" });
  assert.match(result.error, /git/);
  assert.deepEqual(result.files, []);
});

test("an exec that throws is also an error", async () => {
  const result = await changedFiles({
    exec: async () => {
      throw new Error("spawn failed");
    },
    root: "/r",
  });
  assert.match(result.error, /spawn failed/);
});
