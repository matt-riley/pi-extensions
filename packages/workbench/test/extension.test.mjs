import assert from "node:assert/strict";
import { test } from "node:test";

async function harness({ choices = [], inputs = [], draft = "", mode = "tui", entries = [] } = {}) {
  const { installWorkbench } = await import("../workbench.mjs");
  const commands = {},
    shortcuts = {},
    handlers = {},
    dialogs = [],
    notices = [],
    saved = [];
  let text = draft;
  const pi = {
    registerCommand: (name, def) => {
      commands[name] = def;
    },
    registerShortcut: (name, def) => {
      shortcuts[name] = def;
    },
    getCommands: () => [{ name: "review", description: "Review changes", source: "prompt" }],
    on: (event, fn) => {
      handlers[event] = fn;
    },
    appendEntry: (type, data) => saved.push({ type, data }),
  };
  const ctx = {
    cwd: "/repo",
    mode,
    sessionManager: { getBranch: () => entries },
    ui: {
      select: async (title, options) => {
        dialogs.push({ title, options });
        const choice = choices.shift();
        return typeof choice === "function" ? choice(options) : choice;
      },
      input: async () => inputs.shift(),
      notify: (message) => notices.push(message),
      getEditorText: () => text,
      setEditorText: (value) => {
        text = value;
      },
      setStatus: () => {},
    },
  };
  installWorkbench(pi);
  handlers.session_start({}, ctx);
  return { commands, shortcuts, ctx, dialogs, notices, saved, text: () => text };
}

test("command centre searches by intent and prepares built-ins without sending them to a model", async () => {
  const h = await harness({
    choices: [(items) => items.find((s) => s.includes("Resume a session"))],
  });
  await h.commands.ui.handler("previous conversation", h.ctx);
  assert.equal(h.text(), "/resume");
  assert.match(h.notices[0], /Enter/);
});

test("shortcut cancellation leaves a draft untouched", async () => {
  const h = await harness({ draft: "my unfinished prompt" });
  await h.shortcuts["ctrl+alt+k"].handler(h.ctx);
  assert.equal(h.text(), "my unfinished prompt");
  assert.equal(h.saved.length, 0);
});

test("preparing a command backs up the draft durably, and restore swaps rather than discards", async () => {
  const h = await harness({
    draft: "unfinished",
    choices: [(items) => items.find((s) => s.includes("Resume a session"))],
  });
  await h.commands.ui.handler("previous conversation", h.ctx);
  assert.equal(h.text(), "/resume");
  assert.deepEqual(h.saved[0], { type: "workbench-draft", data: { text: "unfinished" } });
  await h.commands.ui.handler("restore", h.ctx);
  assert.equal(h.text(), "unfinished");
  assert.deepEqual(h.saved.at(-1).data, { text: "/resume" });
});

test("a reload restores the saved draft from the active branch, and another preparation cannot overwrite it", async () => {
  const h = await harness({
    draft: "second draft",
    entries: [{ type: "custom", customType: "workbench-draft", data: { text: "first draft" } }],
    choices: [(items) => items.find((s) => s.includes("Resume a session"))],
  });
  await h.commands.ui.handler("previous conversation", h.ctx);
  assert.equal(h.text(), "second draft");
  assert.equal(h.saved.length, 0);
  assert.match(h.notices[0], /restore/i);
  await h.commands.ui.handler("restore", h.ctx);
  assert.equal(h.text(), "first draft");
});

test("search cancellation and no matches leave the editor untouched; non-TUI calls do not open dialogs", async () => {
  const h = await harness({
    draft: "keep",
    choices: [(items) => items.find((s) => s.startsWith("Search"))],
  });
  await h.commands.ui.handler("", h.ctx);
  assert.equal(h.text(), "keep");
  await h.commands.ui.handler("no such command xyz", h.ctx);
  assert.match(h.notices.at(-1), /No matches/);
  const rpc = await harness({ mode: "rpc" });
  await rpc.commands.ui.handler("", rpc.ctx);
  assert.equal(rpc.dialogs.length, 0);
  assert.match(rpc.notices[0], /terminal/i);
});
