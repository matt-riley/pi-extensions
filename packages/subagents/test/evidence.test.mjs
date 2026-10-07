import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { collectEvidence, assessEvidence, revisionSnapshot } from "../evidence.mjs";

test("only actual matching successful commands at an unchanged revision verify acceptance", () => {
  const evidence = [];
  collectEvidence(evidence, {
    type: "tool_execution_start",
    toolName: "bash",
    toolCallId: "t",
    args: { command: "npm test" },
  });
  collectEvidence(evidence, {
    type: "tool_execution_end",
    toolCallId: "t",
    isError: false,
    result: { content: [{ type: "text", text: "passed" }] },
  });
  const base = {
    criteria: [{ criterion: "regression passes", command: "npm test" }],
    evidence,
    before: { fingerprint: "a" },
    after: { fingerprint: "a" },
    status: "completed",
  };
  assert.equal(assessEvidence(base).outcome, "verified");
  assert.equal(assessEvidence({ ...base, after: { fingerprint: "b" } }).outcome, "partial");
  assert.equal(assessEvidence({ ...base, evidence: [] }).outcome, "partial");
  assert.equal(assessEvidence({ ...base, transcriptSaved: false }).outcome, "partial");
  assert.equal(assessEvidence({ ...base, status: "timed out" }).outcome, "partial");
  assert.equal(
    assessEvidence({ ...base, evidence: [{ command: "npm test", success: false }] }).outcome,
    "failed",
  );
  assert.equal(assessEvidence({ status: "completed" }).outcome, "unknown");
});

test("snapshot includes same-line-count edits, staged state and untracked content", async (t) => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-evidence-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd, stdio: "pipe", timeout: 10000 });
  git("init");
  git("config", "user.name", "Fixture");
  git("config", "user.email", "fixture@example.test");
  await writeFile(path.join(cwd, "a"), "first\n");
  git("add", "a");
  git("-c", "commit.gpgsign=false", "commit", "-m", "fixture");
  const initial = await revisionSnapshot(cwd);
  await writeFile(path.join(cwd, "a"), "other\n");
  const dirty = await revisionSnapshot(cwd);
  assert.notEqual(initial.fingerprint, dirty.fingerprint);
  git("add", "a");
  assert.notEqual((await revisionSnapshot(cwd)).fingerprint, dirty.fingerprint);
  await writeFile(path.join(cwd, "scratch"), "one");
  const untracked = await revisionSnapshot(cwd);
  await writeFile(path.join(cwd, "scratch"), "two");
  assert.notEqual((await revisionSnapshot(cwd)).fingerprint, untracked.fingerprint);
});
