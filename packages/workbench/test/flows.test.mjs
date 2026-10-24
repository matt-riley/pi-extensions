import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { harness } from "./ui-fixture.mjs";

test("files filter live and append a reference without reading contents", async () => {
  const h = harness([["b.txt", "enter"]]);
  await h.commands.files.handler("", h.ctx);
  assert.equal(h.text(), 'keep "src/b.txt"');
  assert.equal(h.calls.length, 2);
  assert.ok(h.calls.every((call) => call.cmd === "git"));
});
test("non-editable diffs escape control bytes; inserting a reference ends the flow", async () => {
  const h = harness([["enter"], ["escape"], ["enter"], ["i"]]);
  await h.commands.changes.handler("", h.ctx);
  const previews = h.screens.filter(
    (lines) => lines[0].includes("— read-only") && !lines[0].includes("Changes"),
  );
  assert.ok(previews.length >= 2);
  assert.match(previews[0][0], /unstaged/);
  assert.ok(!previews[0].join("\n").includes(String.fromCharCode(27)));
  assert.match(previews[0].join("\n"), /\\u001b/);
  assert.equal(h.text(), 'keep "src/a.txt"');
  assert.ok(!h.calls.some((call) => call.args.includes("add") || call.args.includes("commit")));
});
test("Git errors are visible and busy mode never takes dialog focus or executes Git", async () => {
  const failed = harness([], { fail: true });
  await failed.commands.changes.handler("", failed.ctx);
  assert.match(failed.notices[0], /Git unavailable/);
  const busy = harness([], { busy: true });
  await busy.commands.files.handler("", busy.ctx);
  assert.equal(busy.calls.length, 0);
  assert.match(busy.notices[0], /Wait/);
  assert.equal(busy.text(), "keep");
});
test("branch navigation restores the branch backup rather than a sibling draft", async () => {
  const h = harness([], {
    entries: [{ type: "custom", customType: "workbench-draft", data: { text: "first branch" } }],
  });
  h.ctx.sessionManager.getBranch = () => [];
  h.handlers.session_tree({}, h.ctx);
  await h.commands.ui.handler("restore", h.ctx);
  assert.equal(h.text(), "keep");
  assert.match(h.notices[0], /No saved draft/);
});
test("native Neovim launch failures still restore terminal ownership", async (t) => {
  const fixture = await mkdtemp(path.join(tmpdir(), "pi-nvim-failure-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const h = harness([["enter"], ["e"]], { root: path.join(fixture, "missing") });
  await h.commands.changes.handler("", h.ctx);
  assert.deepEqual(h.lifecycle, ["stop", "start"]);
  assert.match(h.notices[0], /ENOENT/);
});
test("review return retains the typed filter, selected scope and separate scroll positions", async () => {
  const h = harness([
    ["a.txt", "down", "enter"],
    ["pageDown", "left"],
    ["pageDown", "right"],
    (component, render) => {
      assert.ok(render().some((line) => line.includes("Line 22/")));
      component.handleInput("escape");
    },
    (component, render) => {
      const lines = render();
      assert.ok(lines.includes("> a.txt"));
      assert.match(
        lines.find((line) => line.startsWith("→")),
        /unstaged/,
      );
      component.handleInput("escape");
    },
  ]);
  const exec = h.pi.exec;
  h.pi.exec = async (cmd, args) => {
    if (args.includes("status")) return { code: 0, stdout: "MM src/a.txt\0 M src/b.txt\0" };
    if (args.includes("diff"))
      return { code: 0, stdout: Array.from({ length: 80 }, (_, i) => "+line " + i).join("\n") };
    return exec(cmd, args);
  };
  await h.commands.changes.handler("", h.ctx);
  assert.deepEqual(h.notices, []);
  assert.equal(h.text(), "keep");
});
