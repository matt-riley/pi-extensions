import assert from "node:assert/strict";
import { test } from "node:test";
import quality from "../index.ts";

function setup({ git = true, source = "main.go\0" } = {}) {
  const commands = new Map();
  const messages = [];
  const notes = [];
  const calls = [];
  quality({
    registerCommand: (name, definition) => commands.set(name, definition),
    exec: async (cmd, args) => {
      calls.push(cmd);
      if (cmd === "git")
        return { code: git ? 0 : 128, stdout: args.includes("rev-parse") ? "/repo\n" : source };
      return { code: 2, stdout: "", stderr: "incomplete fixture scan" };
    },
    sendUserMessage: (text, options) => messages.push({ text, options }),
  });
  const ctx = { cwd: "/repo/sub", ui: { notify: (text, level) => notes.push({ text, level }) } };
  return {
    run: (args = "") => commands.get("quality").handler(args, ctx),
    messages,
    notes,
    calls,
    ctx,
  };
}

test("/quality executes both scans and queues repository-wide cleanup even when scans fail", async () => {
  const h = setup();
  await h.run();
  assert.deepEqual(h.calls, ["git", "git", "crap", "deadwood"]);
  assert.equal(h.messages.length, 1);
  assert.deepEqual(h.messages[0].options, { deliverAs: "followUp" });
  assert.match(
    h.messages[0].text,
    /Inspect the whole repository, not just the current diff or comments\./,
  );
  assert.match(h.messages[0].text, /incomplete fixture scan/);
  assert.equal(h.notes[0].level, "warning");
  assert.match(h.notes[0].text, /crap: error \(exit 2\)/);
});

test("no repository and invalid arguments do not start a cleanup", async () => {
  for (const invalid of [false, true]) {
    const h = setup({ git: false });
    await h.run(invalid ? "--fix" : "");
    assert.equal(h.messages.length, 0);
    assert.equal(h.notes.length, 1);
    assert.match(
      h.notes[0].text,
      invalid ? /Usage: \/quality/ : /Skipped: no readable Git repository/,
    );
  }
});

test("unsupported CLI languages still get native lint cleanup, with explicit scan gaps", async () => {
  const h = setup({ source: "main.py\0" });
  await h.run();
  assert.deepEqual(h.calls, ["git", "git"]);
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0].text, /Skipped: no supported JS\/TS, Go, Rust or Lua source files/);
});

test("an aborted scan does not queue another agent turn", async () => {
  const h = setup();
  h.ctx.signal = AbortSignal.abort();
  await h.run();
  assert.equal(h.messages.length, 0);
});
