import assert from "node:assert/strict";
import { test } from "node:test";
import { installWorkbench } from "../workbench.mjs";
import { commandTypos } from "../typos.mjs";

function harness(commands = [{ name: "exit" }]) {
  const handlers = {},
    notices = [];
  let text = "";
  const pi = {
    on: (name, fn) => {
      handlers[name] = fn;
    },
    registerCommand() {},
    registerShortcut() {},
    getCommands: () => commands,
  };
  const ctx = {
    mode: "tui",
    ui: {
      getEditorText: () => text,
      setEditorText: (value) => {
        text = value;
      },
      notify: (message) => notices.push(message),
    },
  };
  installWorkbench(pi);
  return { handlers, ctx, notices, text: () => text };
}

test("a transposed slash command is consumed and restored, never executed or autocorrected", () => {
  const h = harness();
  assert.deepEqual(h.handlers.input({ source: "interactive", text: "/eixt now" }, h.ctx), {
    action: "handled",
  });
  assert.equal(h.text(), "/eixt now");
  assert.match(h.notices[0], /Did you mean \/exit/);
});

test("one insertion, deletion, substitution, transposition and wrong case suggest current commands", () => {
  for (const typo of ["/exitt", "/exi", "/exut", "/eixt", "/Exit"])
    assert.ok(commandTypos(typo, [{ name: "exit" }]).includes("exit"), typo);
  assert.deepEqual(commandTypos("/rleoad", []), ["reload"]);
  assert.deepEqual(commandTypos("/revieq", [{ name: "review", source: "prompt" }]), ["review"]);
  assert.deepEqual(commandTypos("/skill:tset", [{ name: "skill:test", source: "skill" }]), [
    "skill:test",
  ]);
});
test("known commands, paths, slash prose and distant unknown names are not treated as typos", () => {
  for (const text of [
    "/exit",
    "/review please",
    "/skill:test",
    "/model",
    "/thinking high",
    "/tmp/file",
    "/tmp",
    "//eixt",
    "/ is division",
    "mention /eixt",
    "/eixt\nprose",
    "/distant-command",
    "/" + "a".repeat(65),
  ])
    assert.deepEqual(
      commandTypos(text, [{ name: "exit" }, { name: "review" }, { name: "skill:test" }]),
      [],
      text,
    );
  const commands = [{ name: "exit" }];
  assert.deepEqual(commandTypos("/eixt", commands), ["exit"]);
  commands.push({ name: "eixt" });
  assert.deepEqual(commandTypos("/eixt", commands), [], "registry is never cached");
});
test("only interactive text-only input is intercepted; new editor text is never discarded", () => {
  for (const mode of ["rpc", "print", "json"]) {
    const h = harness();
    h.ctx.mode = mode;
    assert.deepEqual(h.handlers.input({ source: "interactive", text: "/eixt" }, h.ctx), {
      action: "continue",
    });
    assert.equal(h.text(), "");
  }
  for (const event of [
    { source: "extension", text: "/eixt" },
    { source: "rpc", text: "/eixt" },
    { source: "interactive", text: "/eixt", images: [{ type: "image", data: "fixture" }] },
  ]) {
    const h = harness();
    assert.deepEqual(h.handlers.input(event, h.ctx), { action: "continue" });
    assert.equal(h.text(), "");
    assert.equal(h.notices.length, 0);
  }
  const h = harness();
  h.ctx.ui.setEditorText("new draft");
  h.handlers.input({ source: "interactive", text: "/eixt" }, h.ctx);
  assert.equal(h.text(), "/eixt\nnew draft");
});
