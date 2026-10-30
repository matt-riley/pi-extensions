import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ENV_FACTS_ENV,
  appendFactLine,
  collectEditedPaths,
  commandsSameJob,
  confirmationEligible,
  createEnvFactsSession,
  envFactsEnabled,
  factDisplayLine,
  forgetFact,
  formatFactsList,
  isNotFoundFailure,
  ledgerPath,
  loadLedger,
  matchesFailCommand,
  observeEnvFactsResult,
  recordSessionCandidate,
  saveLedger,
  sessionKey,
  confirmCandidate,
  createEnvFactsRuntime,
  applyConfirmation,
  applyContradiction,
  reconcileFactStatus,
} from "../env-facts.mjs";

test("envFactsEnabled respects PI_DIAGNOSIS_ENV_FACTS kill switch", () => {
  assert.equal(envFactsEnabled({}), true);
  assert.equal(envFactsEnabled({ [ENV_FACTS_ENV]: "off" }), false);
  assert.equal(envFactsEnabled({ [ENV_FACTS_ENV]: "0" }), false);
  assert.equal(envFactsEnabled({ [ENV_FACTS_ENV]: "false" }), false);
});

test("isNotFoundFailure recognises common signatures", () => {
  assert.equal(
    isNotFoundFailure({ isError: true, output: "bash: pytest: command not found" }),
    true,
  );
  assert.equal(
    isNotFoundFailure({ isError: true, output: "python: No module named pytest" }),
    true,
  );
  assert.equal(isNotFoundFailure({ isError: true, exitCode: 127, output: "" }), true);
  assert.equal(isNotFoundFailure({ isError: true, output: "ENOENT spawn pytest" }), true);
  assert.equal(isNotFoundFailure({ isError: false, output: "ok" }), false);
  assert.equal(isNotFoundFailure({ isError: true, output: "AssertionError" }), false);
});

test("commandsSameJob links a bare failure to a launcher success", () => {
  assert.deepEqual(
    commandsSameJob({
      failCommand: "pytest -q",
      failOutput: "bash: pytest: command not found",
      okCommand: "python -m pytest -q",
    }),
    { fail: "pytest", ok: "python -m pytest" },
  );
  assert.deepEqual(
    commandsSameJob({
      failCommand: "eslint .",
      failOutput: "eslint: command not found",
      okCommand: "npx eslint .",
    }),
    { fail: "eslint", ok: "npx eslint" },
  );
  assert.equal(
    commandsSameJob({
      failCommand: "pytest",
      failOutput: "command not found",
      okCommand: "npm test",
    }),
    null,
  );
});

test("recordSessionCandidate learns A fails, use B within one session", () => {
  const session = createEnvFactsSession();
  observeEnvFactsResult(session, {
    toolName: "bash",
    isError: true,
    input: { command: "pytest" },
    output: "bash: pytest: command not found",
    exitCode: 127,
  });
  const learned = recordSessionCandidate(session, {
    toolName: "bash",
    isError: false,
    input: { command: "python -m pytest" },
    output: "ok",
    exitCode: 0,
  });
  assert.deepEqual(learned, { fail: "pytest", ok: "python -m pytest" });
});

test("confirmation needs three sessions with non-overlapping edits", () => {
  const fact = {
    id: "f1",
    fail: "pytest",
    ok: "python -m pytest",
    confirmations: [],
    contradictions: 0,
    score: 0,
    status: "candidate",
  };
  assert.equal(confirmationEligible(fact, { sessionId: "s1", editedFiles: ["a.js"] }), true);
  applyConfirmation(fact, { sessionId: "s1", editedFiles: ["a.js"] });
  assert.equal(fact.status, "candidate");
  assert.equal(
    confirmationEligible(fact, { sessionId: "s2", editedFiles: ["a.js"] }),
    false,
    "overlapping edits block another confirmation",
  );
  assert.equal(confirmationEligible(fact, { sessionId: "s2", editedFiles: ["b.js"] }), true);
  applyConfirmation(fact, { sessionId: "s2", editedFiles: ["b.js"] });
  applyConfirmation(fact, { sessionId: "s3", editedFiles: [] });
  reconcileFactStatus(fact);
  assert.equal(fact.status, "confirmed");
  assert.equal(fact.confirmations.length, 3);
});

test("contradiction weighs five times a confirmation", () => {
  const fact = {
    id: "f1",
    fail: "pytest",
    ok: "python -m pytest",
    confirmations: [
      { sessionId: "s1", editedFiles: ["a.js"] },
      { sessionId: "s2", editedFiles: ["b.js"] },
      { sessionId: "s3", editedFiles: ["c.js"] },
    ],
    contradictions: 0,
    score: 3,
    status: "confirmed",
  };
  applyContradiction(fact);
  assert.equal(fact.score, -2);
  assert.equal(fact.contradictions, 1);
  reconcileFactStatus(fact);
  assert.equal(fact.status, "retired");
});

test("retired facts stay retired and are not re-learned", () => {
  const ledger = {
    version: 1,
    facts: [
      {
        id: "dead",
        fail: "pytest",
        ok: "python -m pytest",
        confirmations: [],
        contradictions: 1,
        score: -5,
        status: "retired",
      },
    ],
    retiredKeys: ["pytest\u0000python -m pytest"],
  };
  const added = confirmCandidate(ledger, { fail: "pytest", ok: "python -m pytest" }, "s9", [
    "z.js",
  ]);
  assert.equal(added, null);
  assert.equal(ledger.facts.length, 1);
});

test("confirmed facts show only on a matching failure", () => {
  const fact = {
    id: "live",
    fail: "pytest",
    ok: "python -m pytest",
    confirmations: [{ sessionId: "s1", editedFiles: [] }],
    contradictions: 0,
    score: 1,
    status: "confirmed",
  };
  assert.equal(matchesFailCommand("pytest -q", fact), true);
  assert.equal(matchesFailCommand("python -m pytest", fact), false);
  const line = factDisplayLine(fact);
  assert.match(line, /Repo fact \(seen in 1 session\)/);
  assert.match(line, /`pytest`/);
  assert.match(line, /`python -m pytest`/);
  const content = [{ type: "text", text: "boom" }];
  const patched = appendFactLine(content, line);
  assert.equal(patched.length, 2);
});

test("forgetFact retires by id", () => {
  const ledger = {
    version: 1,
    facts: [
      {
        id: "keep",
        fail: "eslint",
        ok: "npx eslint",
        confirmations: [],
        score: 0,
        status: "candidate",
      },
      {
        id: "drop",
        fail: "pytest",
        ok: "python -m pytest",
        confirmations: [],
        score: 2,
        status: "confirmed",
      },
    ],
    retiredKeys: [],
  };
  const msg = forgetFact(ledger, "drop");
  assert.match(msg, /Retired env fact drop/i);
  assert.equal(ledger.facts.find((f) => f.id === "drop").status, "retired");
  assert.equal(ledger.retiredKeys.includes("pytest\u0000python -m pytest"), true);
});

test("loadLedger and saveLedger round-trip atomically", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "env-facts-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = ledgerPath(dir, "/repo/root");
  const ledger = {
    version: 1,
    facts: [{ id: "x", fail: "a", ok: "b", confirmations: [], score: 0, status: "candidate" }],
    retiredKeys: [],
  };
  await saveLedger(path, ledger, { mkdir, writeFile, rename, rm });
  const loaded = await loadLedger(path, { readFile });
  assert.deepEqual(loaded, ledger);
});

test("collectEditedPaths gathers mutation tool paths", () => {
  const session = createEnvFactsSession();
  collectEditedPaths(session, { toolName: "write", input: { path: "src/a.ts" } });
  collectEditedPaths(session, { toolName: "edit", input: { file_path: "src/b.ts" } });
  collectEditedPaths(session, { toolName: "read", input: { path: "src/b.ts" } });
  assert.deepEqual([...session.editedFiles].sort(), ["src/a.ts", "src/b.ts"]);
});

test("formatFactsList lists statuses for /diagnosis facts", () => {
  const text = formatFactsList({
    version: 1,
    facts: [
      { id: "c1", fail: "pytest", ok: "python -m pytest", status: "confirmed", score: 3 },
      { id: "c2", fail: "eslint", ok: "npx eslint", status: "candidate", score: 1 },
    ],
    retiredKeys: [],
  });
  assert.match(text, /c1/);
  assert.match(text, /confirmed/);
  assert.match(text, /candidate/);
});

test("createEnvFactsRuntime skips learning when the kill switch is off", async () => {
  const runtime = createEnvFactsRuntime({
    getAgentDir: () => "/tmp/agent",
    findRepoRoot: async (cwd) => ({ root: cwd, viaGit: false }),
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
    env: { [ENV_FACTS_ENV]: "off" },
  });
  await runtime.onSessionStart({ cwd: "/repo", sessionId: "s1" });
  runtime.onToolCall({ toolName: "write", input: { path: "a.js" } });
  const line = await runtime.onToolResult(
    {
      toolName: "bash",
      isError: true,
      input: { command: "pytest" },
      content: [{ type: "text", text: "command not found" }],
      result: { structuredContent: { exit_code: 127 } },
    },
    { sessionId: "s1" },
  );
  assert.equal(line, null);
  assert.equal(runtime.getLedger().facts.length, 0);
});

test("sessionKey prefers ctx.sessionId", () => {
  assert.equal(sessionKey({ sessionId: " abc " }), "abc");
  assert.equal(sessionKey({ session: { id: "from-session" } }), "from-session");
  assert.equal(sessionKey({}), "local");
});
