// Matt's own `!` runs count as a check only when the saved session message says
// it passed cleanly, on the tree as it is now, and it was not a `!!` run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import extension from "../index.ts";
import { userBashEvidence } from "../user-bash.mjs";

const rev = (fingerprint, head = "h1") => ({ head, fingerprint, clean: false });

const message = (overrides = {}) => ({
  role: "bashExecution",
  command: "npm test",
  output: "ok",
  exitCode: 0,
  cancelled: false,
  truncated: false,
  timestamp: 2000,
  ...overrides,
});
const started = (overrides = {}) => ({
  command: "npm test",
  at: 1000,
  before: rev("f1"),
  ...overrides,
});

test("a clean pass on an unchanged tree counts", () => {
  const hit = userBashEvidence({
    messages: [message()],
    started: [started()],
    current: rev("f1"),
  });
  assert.deepEqual(hit, { revision: rev("f1") });
});

test("each of these leaves the run uncounted", () => {
  const cases = {
    failed: { messages: [message({ exitCode: 1 })] },
    "no exit code": { messages: [message({ exitCode: undefined })] },
    truncated: { messages: [message({ truncated: true })] },
    cancelled: { messages: [message({ cancelled: true })] },
    "`!!` (excludeFromContext)": { messages: [message({ excludeFromContext: true })] },
    "not a recognised check": {
      messages: [message({ command: "ls -la" })],
      started: [started({ command: "ls -la" })],
    },
    stale: { current: rev("f2") },
    "head moved": { current: rev("f1", "h2") },
    "no run was started": { started: [] },
    "started for another command": { started: [started({ command: "npm run lint" })] },
    "started after the message": { started: [started({ at: 3000 })] },
    "start has no fingerprint": { started: [started({ before: null })] },
    "no current fingerprint": { current: null },
  };
  for (const [name, override] of Object.entries(cases)) {
    const hit = userBashEvidence({
      messages: [message()],
      started: [started()],
      current: rev("f1"),
      ...override,
    });
    assert.equal(hit, null, name);
  }
});

test("only the newest recognised run decides: a later failure undoes an earlier pass", () => {
  const messages = [message({ timestamp: 2000 }), message({ timestamp: 4000, exitCode: 2 })];
  const runs = [started(), started({ at: 3500 })];
  assert.equal(userBashEvidence({ messages, started: runs, current: rev("f1") }), null);
  const pass = [message({ timestamp: 2000, exitCode: 1 }), message({ timestamp: 4000 })];
  assert.ok(userBashEvidence({ messages: pass, started: runs, current: rev("f1") }));
});

test("messages that are not bash executions are ignored", () => {
  assert.equal(
    userBashEvidence({
      messages: [{ role: "user", content: "npm test" }, undefined],
      started: [started()],
      current: rev("f1"),
    }),
    null,
  );
});

// --- through the extension -----------------------------------------------------

function harness(t) {
  const cwd = mkdtempSync(join(tmpdir(), "done-gate-userbash-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", ["-C", cwd, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.com");
  writeFileSync(join(cwd, "a.js"), "export default 1;\n");
  git("add", ".");
  git("commit", "-qm", "test: base");
  const handlers = {};
  const branch = [];
  const ctx = { cwd, sessionManager: { getBranch: () => branch } };
  extension({
    registerTool() {},
    on: (name, fn) => {
      handlers[name] = fn;
    },
    exec: async (file, args) => {
      const r = spawnSync(file, args, { cwd, encoding: "utf8" });
      return { code: r.status, stdout: r.stdout, stderr: r.stderr };
    },
  });
  return {
    cwd,
    write: (value) => writeFileSync(join(cwd, "a.js"), value),
    edit: () =>
      handlers.tool_result({ toolName: "edit", input: { path: "a.js" }, isError: false }, ctx),
    /** The user types `!command`: the host fires user_bash, runs it, then saves the message. */
    bang: async ({
      command = "npm test",
      start = true,
      save = true,
      event = {},
      saved = {},
      during,
    } = {}) => {
      const returned = start
        ? await handlers.user_bash({ command, excludeFromContext: false, cwd, ...event }, ctx)
        : undefined;
      during?.();
      if (save) {
        branch.push({
          type: "message",
          message: {
            role: "bashExecution",
            command,
            output: "ok",
            exitCode: 0,
            cancelled: false,
            truncated: false,
            timestamp: Date.now() + 1,
            ...saved,
          },
        });
      }
      return returned;
    },
    settle: () => handlers.agent_before_settle({ outcome: "completed", entries: [] }, ctx),
  };
}

test("a clean `!npm test` after the edit counts: no reminder at settle", async (t) => {
  const h = harness(t);
  h.write("export default 2;\n");
  await h.edit();
  await h.bang();
  assert.equal(await h.settle(), undefined);
});

test("user_bash alone never counts: a run that was started but not saved is not evidence", async (t) => {
  const h = harness(t);
  h.write("export default 2;\n");
  await h.edit();
  await h.bang({ save: false });
  assert.equal((await h.settle()).continue, true);
});

test("user_bash does not intercept the command", async (t) => {
  const h = harness(t);
  assert.equal(await h.bang(), undefined);
});

test("failed, truncated, stale and `!!` runs each leave the edit unverified", async (t) => {
  const runs = {
    failed: { saved: { exitCode: 1 } },
    truncated: { saved: { truncated: true } },
    "!!": { event: { excludeFromContext: true }, saved: { excludeFromContext: true } },
    stale: { during: "edit-after-start" },
  };
  for (const [name, options] of Object.entries(runs)) {
    const h = harness(t);
    h.write("export default 2;\n");
    await h.edit();
    await h.bang({
      ...options,
      during: options.during ? () => h.write("export default 3;\n") : undefined,
    });
    assert.equal((await h.settle())?.continue, true, name);
  }
});

test("a run saved without a recorded start (e.g. after /reload) is not counted", async (t) => {
  const h = harness(t);
  h.write("export default 2;\n");
  await h.edit();
  await h.bang({ start: false });
  assert.equal((await h.settle())?.continue, true);
});
