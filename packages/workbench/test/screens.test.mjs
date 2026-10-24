import assert from "node:assert/strict";
import { test } from "node:test";
import { installWorkbench } from "../workbench.mjs";
import { terminal, widgets } from "./ui-fixture.mjs";
import * as screens from "../screens.mjs";

test("file results update as text is typed in one interaction", async () => {
  const commands = {};
  let draft = "keep";
  const t = terminal([["b.txt", "enter"]]);
  installWorkbench(
    {
      on() {},
      registerShortcut() {},
      registerCommand: (name, def) => {
        commands[name] = def;
      },
      exec: async (_cmd, args) => ({
        code: 0,
        stdout: args.includes("rev-parse") ? "/repo\n" : "a.txt\0b.txt\0",
      }),
    },
    widgets,
  );
  await commands.files.handler("", {
    cwd: "/repo",
    mode: "tui",
    ui: {
      ...t,
      getEditorText: () => draft,
      setEditorText: (v) => {
        draft = v;
      },
      notify: (message) => {
        throw Error(message);
      },
      select: () => {
        throw Error("must not use separate search/select dialogs");
      },
    },
  });
  assert.equal(draft, 'keep "b.txt"');
  assert.ok(
    t.screens.some(
      (lines) =>
        lines.some((line) => line.includes("> b.txt")) &&
        !lines.some((line) => line.includes("a.txt")),
    ),
  );
});

test("diff review is non-editable and restores its scroll position after handoff", async () => {
  assert.equal(
    typeof screens.preview,
    "function",
    "a read-only diff surface replaces the scratch editor",
  );
  const state = { offset: 0 };
  const text = Array.from({ length: 60 }, (_, i) => "+line " + i).join("\n");
  const t = terminal(
    [
      ["pageDown", "e"],
      (component, render) => {
        assert.ok(render().some((line) => line.includes("+line 16")));
        component.handleInput("arbitrary edits");
        assert.ok(render().some((line) => line.includes("+line 16")));
        component.handleInput("escape");
      },
    ],
    25,
  );
  const ctx = { ui: t };
  assert.equal(
    await screens.preview(ctx, { scope: "staged", file: "a.txt" }, text, state, widgets),
    "neovim",
  );
  assert.equal(state.offset, 16);
  assert.equal(
    await screens.preview(ctx, { scope: "staged", file: "a.txt" }, text, state, widgets),
    undefined,
  );
  assert.equal(state.offset, 16);
});

test("live picker recovers from zero matches, forwards focus and preserves identity with new item objects", async () => {
  const items = [
      { id: "a", label: "Alpha" },
      { id: "b", label: "Beta" },
    ],
    state = { query: "", selected: "b" };
  const t = terminal([
    (component, render) => {
      assert.equal(component.focused, true);
      component.focused = false;
      assert.equal(component.focused, false);
      component.handleInput("xyz");
      assert.ok(render().some((line) => line.includes("0 matches")));
      component.handleInput("enter");
      for (let i = 0; i < 3; i++) component.handleInput("backspace");
      assert.ok(render().some((line) => line.includes("2 matches")));
      component.handleInput("down");
      component.handleInput("enter");
    },
    ["enter"],
  ]);
  assert.equal((await screens.pick({ ui: t }, "Pick", items, state, widgets)).id, "b");
  assert.equal(
    (
      await screens.pick(
        { ui: t },
        "Pick",
        items.map((item) => ({ ...item })),
        state,
        widgets,
      )
    ).id,
    "b",
  );
});
test("picker paging reaches beyond 200 matches and rendered control bytes are inert", async () => {
  const items = Array.from({ length: 240 }, (_, i) => ({ id: String(i), label: "File " + i }));
  const state = { query: "", selected: "230" };
  const t = terminal([["pageDown", "pageUp", "enter"]]);
  const item = await screens.pick({ ui: t }, "Pick", items, state, widgets);
  assert.equal(item.id, "227");
  assert.ok(t.screens[0].some((line) => line.includes("240 matches")));
  const escaped = terminal([["escape"]]);
  await screens.pick(
    { ui: escaped },
    "Pick",
    [{ id: "a", label: "evil" + String.fromCharCode(27) + "[2J", description: "new\nline" }],
    {},
    widgets,
  );
  assert.ok(!escaped.screens.flat().join("\n").includes(String.fromCharCode(27)));
});
test("diff scrolls clamp at both ends and survive resize and invalidation", async () => {
  const state = { offset: 999 };
  const t = terminal(
    [
      (component, render) => {
        assert.ok(render().some((line) => line.includes("Line 5/20")));
        component.handleInput("home");
        assert.equal(state.offset, 0);
        component.handleInput("up");
        assert.equal(state.offset, 0);
        component.handleInput("down");
        assert.equal(state.offset, 1);
        component.handleInput("pageUp");
        assert.equal(state.offset, 0);
        component.handleInput("end");
        assert.equal(state.offset, 4);
        t.tui.terminal.rows = 40;
        component.invalidate();
        render();
        assert.equal(state.offset, 0);
        component.handleInput("escape");
      },
    ],
    25,
  );
  await screens.preview(
    { ui: t },
    { scope: "untracked", file: "wide工作.txt" },
    Array.from({ length: 20 }, (_, i) => "-" + i + "\t@").join("\n"),
    state,
    widgets,
  );
  assert.equal(state.offset, 0);
});
