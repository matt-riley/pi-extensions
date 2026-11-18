import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../index.ts";
import { Jobs } from "../../jobs/jobs.mjs";

function harness(t) {
  const cwd = mkdtempSync(join(tmpdir(), "done-gate-host-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", ["-C", cwd, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.com");
  writeFileSync(join(cwd, "a.js"), "export default 1;\n");
  // A test that imports the edited file, so a run of it is evidence for edits to a.js.
  writeFileSync(join(cwd, "a.test.js"), 'import "./a.js";\n');
  git("add", ".");
  git("commit", "-qm", "test: base");
  const handlers = {};
  const ctx = { cwd };
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
  let id = 0;
  const jobs = new Jobs();
  t.after(() => jobs.shutdown());
  return {
    jobs,
    cwd,
    background: async (command = "node --test --test-isolation=none") => {
      const event = { toolName: "terminal_start", toolCallId: String(++id), input: { command } };
      await handlers.tool_call(event, ctx);
      const job = await jobs.start({ command, cwd });
      await handlers.tool_result(
        { ...event, isError: false, details: { job: jobs.evidence(job.id) } },
        ctx,
      );
      return job.id;
    },
    readJob: async (jobId, wait = true) => {
      if (wait) await jobs.wait(jobId, { timeoutMs: 3000 });
      const job = jobs.evidence(jobId);
      const event = {
        toolName: "terminal_read",
        toolCallId: String(++id),
        input: { id: jobId },
        details: { job },
        isError: job.status === "exited" && job.exit_code !== 0,
        content: [],
      };
      await handlers.tool_result(event, ctx);
    },
    write: (value) => writeFileSync(join(cwd, "a.js"), value),
    edit: () =>
      handlers.tool_result({ toolName: "edit", input: { path: "a.js" }, isError: false }, ctx),
    check: async ({ command = "rtk node --test a.test.js", failed = false, during, log } = {}) => {
      const event = { toolName: "bash", toolCallId: String(++id), input: { command } };
      await handlers.tool_call(event, ctx);
      during?.();
      const content = log === undefined ? [] : [{ type: "text", text: log }];
      await handlers.tool_result({ ...event, isError: failed, content }, ctx);
    },
    say: (text) =>
      handlers.message_end(
        { message: { role: "assistant", content: [{ type: "text", text }] } },
        ctx,
      ),
    settle: () => handlers.agent_before_settle({ outcome: "completed", entries: [] }, ctx),
    handlersSettle: (event) => handlers.agent_before_settle(event, ctx),
    reset: () => handlers.input({}, ctx),
  };
}

test("completed untouched background checks clear edits, but an old read cannot clear a new edit", async (t) => {
  const h = harness(t);
  h.write("export default 2;\n");
  await h.edit();
  const id = await h.background();
  await h.readJob(id);
  assert.equal(await h.settle(), undefined);
  h.write("export default 3;\n");
  await h.edit();
  await h.readJob(id);
  assert.equal((await h.settle()).continue, true);
});

test("a running background check is attempted, never passed because launch succeeded", async (t) => {
  const h = harness(t);
  h.write("export default 2;\n");
  await h.edit();
  await h.background();
  assert.match((await h.settle()).entries[0].content, /Verification status: attempted/);
});

test("failed, changed-tree and previous-input background results leave code unverified", async (t) => {
  for (const mode of ["failed", "stale", "previous-input"]) {
    const h = harness(t);
    h.write("export default 2;\n");
    await h.edit();
    const id = await h.background(
      mode === "failed" ? "node --test --test-isolation=none absent.test.mjs" : undefined,
    );
    await h.jobs.wait(id, { timeoutMs: 3000 });
    if (mode === "stale") h.write("export default 3;\n");
    if (mode === "previous-input") {
      await h.reset();
      await h.edit();
    }
    await h.readJob(id);
    assert.equal((await h.settle()).continue, true, mode);
  }
});

test("real Git identities bind successful host check events to the final tree", async (t) => {
  const h = harness(t);
  h.write("export default 2;\n");
  await h.edit();
  await h.check();
  assert.equal(await h.settle(), undefined);
  h.write("export default 3;\n"); // A shell/external write has no edit event.
  const stale = await h.settle();
  assert.equal(stale.continue, true);
  assert.match(stale.entries[0].content, /Verification status: unknown/);
});

test("a settled Go edit names the package test, and that command clears the gate", async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), "done-gate-scope-host-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", ["-C", cwd, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.com");
  mkdirSync(join(cwd, "pkg/foo"), { recursive: true });
  writeFileSync(join(cwd, "go.mod"), "module example.com/app\n");
  writeFileSync(join(cwd, "pkg/foo/a.go"), "package foo\n");
  writeFileSync(join(cwd, "pkg/foo/a_test.go"), "package foo\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const handlers = {};
  const ctx = { cwd };
  extension({
    registerTool() {},
    on: (name, fn) => {
      handlers[name] = fn;
    },
    exec: async (file, args) => {
      const result = spawnSync(file, args, { cwd, encoding: "utf8" });
      return { code: result.status, stdout: result.stdout, stderr: result.stderr };
    },
  });
  writeFileSync(join(cwd, "pkg/foo/a.go"), "package foo\n\nfunc F() {}\n");
  await handlers.tool_result(
    { toolName: "edit", input: { path: "pkg/foo/a.go" }, isError: false },
    ctx,
  );
  const nudged = await handlers.agent_before_settle({ outcome: "completed", entries: [] }, ctx);
  assert.equal(nudged.continue, true);
  assert.equal(nudged.entries[0].display, false);
  assert.match(nudged.entries[0].content, /`go test \.\/pkg\/foo`/);
  assert.match(nudged.entries[0].content, /close with your explanation of the work/);

  await handlers.input({}, ctx);
  await handlers.tool_result(
    { toolName: "edit", input: { path: "pkg/foo/a.go" }, isError: false },
    ctx,
  );
  const event = { toolName: "bash", toolCallId: "1", input: { command: "go test ./pkg/foo" } };
  await handlers.tool_call(event, ctx);
  await handlers.tool_result({ ...event, isError: false, content: [] }, ctx);
  assert.equal(
    await handlers.agent_before_settle({ outcome: "completed", entries: [] }, ctx),
    undefined,
  );
});

test("failed, masked and tree-changing host checks leave edits unverified", async (t) => {
  const h = harness(t);
  for (const check of [
    { failed: true },
    { command: "false && npm test" },
    { command: "npm test || true" },
    { during: () => h.write("export default 9;\n") },
  ]) {
    await h.reset();
    h.write("export default 2;\n");
    await h.edit();
    await h.check(check);
    assert.equal((await h.settle()).continue, true, JSON.stringify(check));
  }
});

function withVerifyScript(h, body) {
  mkdirSync(join(h.cwd, ".pi"), { recursive: true });
  writeFileSync(join(h.cwd, ".pi", "verify"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

async function settleContent(h) {
  h.write("export default 2;\n");
  await h.edit();
  const result = await h.settle();
  return result.entries.at(-1).content;
}

test("settle points to the recipe as reading, once, even with insufficient evidence", async (t) => {
  for (const command of [null, "npx tsc --noEmit", "node --test missing.test.js"]) {
    const h = harness(t);
    mkdirSync(join(h.cwd, ".pi/verify"), { recursive: true });
    writeFileSync(join(h.cwd, ".pi/verify/SKILL.md"), "# Verify\n");
    h.write("export default 2;\n");
    await h.edit();
    if (command) await h.check({ command });
    const result = await h.settle();
    assert.match(result.entries.at(-1).content, /read `\.pi\/verify\/SKILL\.md`/i);
    assert.doesNotMatch(result.entries.at(-1).content, /run `\.pi\/verify`/);
    assert.equal(await h.settle(), undefined);
  }
});

test("even the retired execution flag cannot launch a suggested executable", async (t) => {
  const h = harness(t);
  withVerifyScript(h, "echo ran > marker");
  const old = process.env.PI_DONE_GATE_EXEC;
  t.after(() => {
    if (old === undefined) delete process.env.PI_DONE_GATE_EXEC;
    else process.env.PI_DONE_GATE_EXEC = old;
  });
  process.env.PI_DONE_GATE_EXEC = "1";
  assert.match(await settleContent(h), /run `\.pi\/verify`/);
  assert.equal(existsSync(join(h.cwd, "marker")), false);
});

test("a typecheck alone leaves the edit unverified and says only compile or lint ran", async (t) => {
  const h = harness(t);
  h.write("export default 2;\n");
  await h.edit();
  await h.check({ command: "npx tsc --noEmit" });
  const result = await h.settle();
  assert.equal(result.continue, true);
  assert.match(result.entries[0].content, /only compile or lint checks ran/i);
});

test("a test run after the typecheck clears the edit", async (t) => {
  const h = harness(t);
  h.write("export default 2;\n");
  await h.edit();
  await h.check({ command: "npx tsc --noEmit" });
  await h.check({ command: "rtk node --test a.test.js" });
  assert.equal(await h.settle(), undefined);
});

const CLEAN_LOG = "# tests 5\n# pass 5\n# fail 0\n";

test("a tests-passed claim the log contradicts is called out even though the run was clean", async (t) => {
  const h = harness(t);
  h.write("export default 2;\n");
  await h.edit();
  await h.check({ log: "# tests 5\n# pass 4\n# fail 1\n" });
  await h.say("All 5 tests pass.");
  const result = await h.settle();
  assert.equal(result.continue, true);
  assert.match(
    result.entries[0].content,
    /says the tests passed, but the log of .* reports failures/,
  );
});

test("a tests-passed claim a clean log backs adds nothing", async (t) => {
  const h = harness(t);
  h.write("export default 2;\n");
  await h.edit();
  await h.check({ log: CLEAN_LOG });
  await h.say("All 5 tests pass.");
  assert.equal(await h.settle(), undefined);
});

test("a test count the log does not show is named", async (t) => {
  const h = harness(t);
  h.write("export default 2;\n");
  await h.edit();
  await h.check({ log: CLEAN_LOG });
  await h.say("All 12 tests pass.");
  assert.match(
    (await h.settle()).entries[0].content,
    /says 12 tests, the log of .* does not show 12/,
  );
});

test("the claim line rides on the verify nudge when edits had no check at all", async (t) => {
  const h = harness(t);
  h.write("export default 2;\n");
  await h.edit();
  await h.say("Tests pass.");
  const content = (await h.settle()).entries[0].content;
  assert.match(content, /^Done check: 1 file\(s\) changed/);
  assert.match(content, /says the tests passed, but no check was recorded/);
});

test("a tests-passed claim with no edits and no runs is left alone", async (t) => {
  const h = harness(t);
  await h.say("Tests pass.");
  assert.equal(await h.settle(), undefined);
});

test("the claim is called out once per user input, and not after an abort", async (t) => {
  const h = harness(t);
  h.write("export default 2;\n");
  await h.edit();
  await h.check({ log: "# fail 2\n" });
  await h.say("All tests pass.");
  assert.equal(await h.handlersSettle?.({ outcome: "aborted", entries: [] }), undefined);
  assert.equal((await h.settle()).continue, true);
  assert.equal(await h.settle(), undefined);
  await h.reset();
  h.write("export default 3;\n");
  await h.edit();
  await h.check({ log: "# fail 2\n" });
  await h.say("All tests pass.");
  assert.equal((await h.settle()).continue, true);
});

// A test run counts only when a test file it ran imports or names an edited file.
async function editedThenRan(t, files, command, log) {
  const h = harness(t);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(h.cwd, name), text);
  h.write("export default 2;\n");
  await h.edit();
  await h.check({ command, log });
  return h;
}

test("a test run whose file imports the edited file clears the gate", async (t) => {
  const h = await editedThenRan(t, {}, "node --test a.test.js");
  assert.equal(await h.settle(), undefined);
});

test("a test run whose file only names the edited file clears the gate", async (t) => {
  const h = await editedThenRan(
    t,
    { "names.test.js": 'import fs from "node:fs";\nfs.readFileSync("./a.js");\n' },
    "node --test names.test.js",
  );
  assert.equal(await h.settle(), undefined);
});

test("a test run of unrelated files does not clear the gate", async (t) => {
  const h = await editedThenRan(
    t,
    { "other.test.js": 'import "node:fs";\n' },
    "node --test other.test.js",
  );
  const nudged = await h.settle();
  assert.equal(nudged.continue, true);
  assert.match(nudged.entries.at(-1).content, /no test file it ran imports or names/i);
});

test("a run whose test files cannot be told is nudged once, with that said", async (t) => {
  const h = await editedThenRan(t, {}, "make test", "all fine\n");
  const nudged = await h.settle();
  assert.match(nudged.entries.at(-1).content, /could not tell which test files `make test` ran/i);
  assert.equal(await h.settle(), undefined);
});

test("files the run's own log lists are enough to tell", async (t) => {
  const h = await editedThenRan(t, {}, "make test", "PASS a.test.js (1 test)\n");
  assert.equal(await h.settle(), undefined);
});

test("publishes unchecked edits for emphasis: an edit opens a span, a covering check closes it", async (t) => {
  const { resetEvidenceState, uncheckedEditsAt } =
    await import("../../../shared/evidence-state.mjs");
  resetEvidenceState();
  t.after(resetEvidenceState);
  const h = harness(t);
  assert.equal(uncheckedEditsAt(), undefined, "nothing is known before done-gate publishes");
  await h.reset();
  assert.equal(uncheckedEditsAt(), false);
  h.write("export default 2;\n");
  await h.edit();
  const editedAt = Date.now();
  assert.equal(uncheckedEditsAt(), true);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await h.check();
  assert.equal(uncheckedEditsAt(), false, "a passing check that reaches the edit clears it");
  assert.equal(uncheckedEditsAt(editedAt), true, "a message written in between stays unchecked");
  h.write("export default 3;\n");
  await h.edit();
  await h.reset();
  assert.equal(uncheckedEditsAt(), false, "a new prompt starts a new run");
});
