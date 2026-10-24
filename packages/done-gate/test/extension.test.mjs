import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../index.ts";

function harness(t) {
  const cwd = mkdtempSync(join(tmpdir(), "done-gate-host-"));
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
  return {
    write: (value) => writeFileSync(join(cwd, "a.js"), value),
    edit: () =>
      handlers.tool_result({ toolName: "edit", input: { path: "a.js" }, isError: false }, ctx),
    check: async ({ command = "rtk npm test", failed = false, during } = {}) => {
      const event = { toolName: "bash", toolCallId: String(++id), input: { command } };
      await handlers.tool_call(event, ctx);
      during?.();
      await handlers.tool_result({ ...event, isError: failed, content: [] }, ctx);
    },
    settle: () => handlers.agent_before_settle({ outcome: "completed", entries: [] }, ctx),
    reset: () => handlers.input({}, ctx),
  };
}

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
