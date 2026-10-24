import assert from "node:assert/strict";
import { test } from "node:test";
import { harness } from "./ui-fixture.mjs";

test("command centre searches by intent and prepares built-ins without sending them to a model", async () => {
  const h = harness([["enter"]], { draft: "" });
  await h.commands.ui.handler("previous conversation", h.ctx);
  assert.equal(h.text(), "/resume");
  assert.match(h.notices[0], /Enter/);
});
test("shortcut cancellation leaves a draft untouched", async () => {
  const h = harness([["escape"]], { draft: "my unfinished prompt" });
  await h.shortcuts["ctrl+alt+k"].handler(h.ctx);
  assert.equal(h.text(), "my unfinished prompt");
  assert.equal(h.saved.length, 0);
});
test("preparing a command backs up the draft durably, and restore swaps rather than discards", async () => {
  const h = harness([["enter"]], { draft: "unfinished" });
  await h.commands.ui.handler("previous conversation", h.ctx);
  assert.equal(h.text(), "/resume");
  assert.deepEqual(h.saved[0], { type: "workbench-draft", data: { text: "unfinished" } });
  await h.commands.ui.handler("restore", h.ctx);
  assert.equal(h.text(), "unfinished");
  assert.deepEqual(h.saved.at(-1).data, { text: "/resume" });
});
test("a reload restores the active branch backup and another preparation cannot overwrite it", async () => {
  const h = harness([["enter"]], {
    draft: "second draft",
    entries: [{ type: "custom", customType: "workbench-draft", data: { text: "first draft" } }],
  });
  await h.commands.ui.handler("previous conversation", h.ctx);
  assert.equal(h.text(), "second draft");
  assert.equal(h.saved.length, 0);
  assert.match(h.notices[0], /restore/i);
  await h.commands.ui.handler("restore", h.ctx);
  assert.equal(h.text(), "first draft");
});
test("no-match searches stay editable and cancellation preserves drafts; non-TUI calls open nothing", async () => {
  const h = harness([["escape"]]);
  await h.commands.ui.handler("no such command xyz", h.ctx);
  assert.equal(h.text(), "keep");
  assert.ok(h.screens[0].some((line) => line.includes("0 matches")));
  const rpc = harness([], { mode: "rpc" });
  await rpc.commands.ui.handler("", rpc.ctx);
  assert.equal(rpc.screens.length, 0);
  assert.match(rpc.notices[0], /terminal/i);
});
test("loaded prompts and skills are prepared rather than dispatched as model messages", async () => {
  for (const command of ["/review", "/skill:test"]) {
    const h = harness([["enter"]], { draft: "" });
    await h.commands.ui.handler(command, h.ctx);
    assert.equal(h.text(), command);
  }
});
