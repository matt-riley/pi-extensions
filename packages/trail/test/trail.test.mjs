import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import extension from "../index.ts";
import { appendDecision, checkEvidence, describeResult, trailPath } from "../trail.mjs";

const root = resolve(import.meta.dirname, "../../..");

function repo(t) {
  const cwd = mkdtempSync(join(tmpdir(), "trail-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", [
      "-C",
      cwd,
      "-c",
      "user.name=T",
      "-c",
      "user.email=t@example.test",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ])
      .toString()
      .trim();
  git("init", "-q");
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src", "parse.mjs"), "one\ntwo\nthree\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const runGit = async (args) => {
    try {
      git(...args);
      return { code: 0 };
    } catch {
      return { code: 1 };
    }
  };
  return { cwd, sha: git("rev-parse", "--short", "HEAD"), runGit };
}

const row = { phase: "fix", decision: "d", why: "w", evidence: "e", result: "open" };

test("a new trail gets a header, an existing one a start row per session", (t) => {
  const { cwd } = repo(t);
  const now = new Date("2026-11-17T00:00:00Z");
  appendDecision(cwd, row, { started: false, session: "s1", now });
  appendDecision(cwd, { ...row, decision: "=risky" }, { started: true, session: "s1", now });
  appendDecision(cwd, row, { started: false, session: "s2", now });
  const lines = readFileSync(trailPath(cwd), "utf8").trim().split("\n");
  assert.deepEqual(lines, [
    "ts\tphase\tdecision\twhy\tevidence\tresult",
    "2026-11-17T00:00:00.000Z\tfix\td\tw\te\topen",
    "2026-11-17T00:00:00.000Z\tfix\t'=risky\tw\te\topen",
    "2026-11-17T00:00:00.000Z\tstart\tsession s2 adds to this log\t\t\t",
    "2026-11-17T00:00:00.000Z\tfix\td\tw\te\topen",
  ]);
  assert.equal(readFileSync(join(cwd, ".pi", "runs", ".gitignore"), "utf8"), "*\n");
});

test("evidence that resolves passes: a path, a real line and a known commit", async (t) => {
  const { cwd, sha, runGit } = repo(t);
  const check = await checkEvidence(`src/parse.mjs:3 at ${sha}, npm test`, cwd, runGit);
  assert.deepEqual(check.problems, []);
  assert.ok(check.checked >= 2);
  assert.match(describeResult("f", check), /evidence resolves$/);
});

test("evidence that does not resolve names each problem", async (t) => {
  const { cwd, runGit } = repo(t);
  const check = await checkEvidence("src/gone.mjs, src/parse.mjs:99, deadbee1", cwd, runGit);
  assert.deepEqual(check.problems, [
    "src/gone.mjs does not exist",
    "src/parse.mjs has no line 99",
    "deadbee1 is not a commit in this repository",
  ]);
  assert.match(describeResult("f", check), /^logged to f; evidence does not resolve: src\/gone/);
});

test("PR numbers, plain words and commands are not treated as pointers", async (t) => {
  const { cwd, runGit } = repo(t);
  const check = await checkEvidence("PR #1234, decade of npm test runs", cwd, runGit);
  assert.deepEqual(check, { ok: true, problems: [], checked: 0 });
  assert.match(
    describeResult("f", check),
    /names no path or commit to check, so it is unverified$/,
  );
});

test("decision_log is a deferred, local, non-read-only tool that writes and reports", async (t) => {
  const { cwd, sha } = repo(t);
  const tools = {};
  const handlers = {};
  extension({
    on: (name, fn) => {
      handlers[name] = fn;
    },
    registerTool: (def) => {
      tools[def.name] = def;
    },
    exec: async (cmd, args) => {
      try {
        execFileSync(cmd, args);
        return { code: 0 };
      } catch {
        return { code: 1 };
      }
    },
  });
  const tool = tools.decision_log;
  assert.equal(tool.exposure, "deferred");
  assert.equal(tool.annotations.readOnlyHint, false);
  const ctx = { cwd, sessionManager: { getSessionId: () => "abc" } };
  const result = await tool.execute(
    "1",
    { ...row, evidence: `${sha} src/parse.mjs:1` },
    undefined,
    undefined,
    ctx,
  );
  assert.match(result.content[0].text, /evidence resolves$/);
  await tool.execute("2", row, undefined, undefined, ctx);
  handlers.session_start();
  await tool.execute("3", row, undefined, undefined, ctx);
  const rows = readFileSync(trailPath(cwd), "utf8").trim().split("\n");
  assert.equal(rows.length, 5);
  assert.match(rows[3], /\tstart\tsession abc adds to this log\t/);
});

test("the trail prompt audits, supersedes rather than edits, and names the reviewer", async () => {
  const text = await readFile(join(root, "prompts/trail.md"), "utf8");
  assert.match(text, /^---\ndescription: /);
  assert.ok(text.includes("Never edit or delete a row; supersede a wrong one with a new row."));
  assert.ok(text.includes("It reviews the trail; it does not redo the work."));
  assert.ok(text.includes("`reviewed by <model>` on its own line"));
  assert.ok(
    text.includes(
      "If no cross-family model was available, or subagents are off, say that instead of naming one.",
    ),
  );
  assert.ok(text.includes("add it with `decision_log`"));
});
