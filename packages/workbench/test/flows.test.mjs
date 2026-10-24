import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { installWorkbench } from "../workbench.mjs";

function harness(choices, { busy = false, fail = false, root = "/repo" } = {}) {
  const commands = {},
    handlers = {},
    notices = [],
    calls = [],
    previews = [];
  let draft = "keep";
  const pi = {
    on: (event, fn) => {
      handlers[event] = fn;
    },
    registerCommand: (name, def) => {
      commands[name] = def;
    },
    registerShortcut() {},
    appendEntry() {},
    getCommands: () => [{ name: "plan" }],
    exec: async (cmd, args) => {
      calls.push({ cmd, args });
      if (fail) return { code: 128, stdout: "", stderr: "Git unavailable" };
      if (args.includes("rev-parse")) return { code: 0, stdout: root + "\n" };
      if (args.includes("ls-files")) return { code: 0, stdout: "src/a.txt\0src/b.txt\0" };
      if (args.includes("status")) return { code: 0, stdout: " M src/a.txt\0" };
      if (args.includes("diff"))
        return { code: 0, stdout: "+hello\n+" + String.fromCharCode(27) + "[2J\n" };
      throw new Error("Unexpected command");
    },
  };
  const ctx = {
    mode: "tui",
    cwd: "/repo",
    isIdle: () => !busy,
    ui: {
      getEditorText: () => draft,
      setEditorText: (value) => {
        draft = value;
      },
      select: async (title, options) => {
        const next = choices.shift();
        return typeof next === "function" ? next(options, title) : next;
      },
      input: async () => "b.txt",
      editor: async (title, text) => {
        previews.push({ title, text });
        return "changed in scratch";
      },
      notify: (message) => notices.push(message),
      setStatus() {},
    },
  };
  return { pi, ctx, commands, handlers, notices, calls, previews, draft: () => draft };
}

test("files search refines native selection and appends a reference without reading contents", async () => {
  const h = harness(["Search…", (options) => options[0]]);
  installWorkbench(h.pi);
  await h.commands.files.handler("", h.ctx);
  assert.equal(h.draft(), 'keep "src/b.txt"');
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every((call) => call.cmd === "git"));
});

test("change previews discard scratch edits and escape control bytes; inserting a reference ends the flow", async () => {
  const h = harness([
    (options) => options[0],
    "Preview diff",
    (options) => options[0],
    "Insert reference",
  ]);
  installWorkbench(h.pi);
  await h.commands.changes.handler("", h.ctx);
  assert.equal(h.previews.length, 1);
  assert.match(h.previews[0].title, /unstaged/);
  assert.ok(!h.previews[0].text.includes(String.fromCharCode(27)));
  assert.match(h.previews[0].text, /\\u001b/);
  assert.equal(h.draft(), 'keep "src/a.txt"');
  assert.ok(!h.calls.some((call) => call.args.includes("add") || call.args.includes("commit")));
});

test("Git errors are visible, and busy mode never takes dialog focus or executes Git", async () => {
  const failed = harness([], { fail: true });
  installWorkbench(failed.pi);
  await failed.commands.changes.handler("", failed.ctx);
  assert.match(failed.notices[0], /Git unavailable/);
  const busy = harness([], { busy: true });
  installWorkbench(busy.pi);
  await busy.commands.files.handler("", busy.ctx);
  assert.equal(busy.calls.length, 0);
  assert.match(busy.notices[0], /Wait/);
  assert.equal(busy.draft(), "keep");
});

test("branch navigation restores the branch's backup rather than a sibling's draft", async () => {
  const h = harness([]);
  let branch = [{ type: "custom", customType: "workbench-draft", data: { text: "first branch" } }];
  h.ctx.sessionManager = { getBranch: () => branch };
  installWorkbench(h.pi);
  h.handlers.session_start({}, h.ctx);
  branch = [];
  h.handlers.session_tree({}, h.ctx);
  await h.commands.ui.handler("restore", h.ctx);
  assert.equal(h.draft(), "keep");
  assert.match(h.notices[0], /No saved draft/);
});

test("native Neovim launch failures still restore terminal ownership", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "pi-nvim-failure-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const h = harness([(options) => options[0], "Open in Neovim (read-only)"], {
    root: path.join(fixture, "missing"),
  });
  const lifecycle = [];
  h.ctx.ui.custom = (factory) =>
    new Promise((resolve) =>
      factory(
        {
          stop: () => lifecycle.push("stop"),
          start: () => lifecycle.push("start"),
          requestRender: () => lifecycle.push("render"),
        },
        {},
        {},
        (value) => {
          lifecycle.push("done");
          resolve(value);
        },
      ),
    );
  installWorkbench(h.pi);
  await h.commands.changes.handler("", h.ctx);
  assert.deepEqual(lifecycle, ["stop", "start", "render", "done"]);
  assert.match(h.notices[0], /ENOENT/);
});
