import assert from "node:assert/strict";
import { test } from "node:test";
import { installFooter } from "../extension.mjs";
import { tui } from "./tui-fixture.mjs";

test("footer refreshes real activity through settlement and keeps detail out of the default view", async () => {
  const handlers = {},
    commands = {},
    notices = [];
  let render,
    refreshes = 0,
    idle = true;
  const statuses = new Map();
  const pi = {
    on: (event, fn) => {
      handlers[event] = fn;
    },
    registerCommand: (name, def) => {
      commands[name] = def;
    },
  };
  const ctx = {
    cwd: "/repo",
    model: { provider: "test", id: "model" },
    thinkingLevel: "high",
    isIdle: () => idle,
    getContextUsage: () => ({ percent: 25 }),
    sessionManager: {
      getBranch: () => [
        {
          type: "message",
          message: { role: "assistant", usage: { input: 100, output: 50, cost: { total: 0.02 } } },
        },
      ],
    },
    ui: {
      notify: (text) => notices.push(text),
      setFooter: (factory) => {
        render = factory?.(
          {
            requestRender: () => {
              refreshes++;
            },
          },
          { fg: (_c, text) => text },
          { getGitBranch: () => "main", getExtensionStatuses: () => statuses },
        ).render;
      },
    },
  };
  installFooter(pi, tui);
  handlers.session_start({}, ctx);
  assert.match(render(100)[0], /repo · main/);
  assert.match(render(100)[0], /ready/);
  assert.doesNotMatch(render(100)[0], /\$/);
  idle = false;
  handlers.agent_start({}, ctx);
  assert.match(render(100)[0], /working/);
  // A low-level run ending is not final settlement.
  handlers.agent_end({}, ctx);
  assert.match(render(100)[0], /working/);
  idle = true;
  handlers.agent_settled({}, ctx);
  assert.match(render(100)[0], /ready/);
  statuses.set("plan-mode", "plan (read-only)");
  assert.match(render(100)[0], /planning/);
  await commands.footer.handler("details", ctx);
  assert.match(notices[0], /100/);
  assert.match(notices[0], /50/);
  assert.match(notices[0], /0.020/);
  assert.match(notices[0], /plan \(read-only\)/);
  assert.ok(refreshes >= 3);
  await commands.footer.handler("", ctx);
  assert.equal(render, undefined);
  await commands.footer.handler("", ctx);
  assert.equal(typeof render, "function");
});

test("the footer lays out its line with the pi-tui helpers it is given", () => {
  let render;
  const handlers = {};
  const pi = { on: (event, fn) => (handlers[event] = fn), registerCommand() {} };
  const ctx = {
    cwd: "/クリーンアップ",
    model: { id: "モデル" },
    ui: {
      setFooter: (factory) => {
        render = factory({}, { fg: (_c, text) => text }, { getGitBranch: () => "main" }).render;
      },
    },
  };
  installFooter(pi, tui);
  handlers.session_start({}, ctx);
  for (const width of [4, 10, 20, 30]) {
    const [line] = render(width);
    assert.ok(tui.visibleWidth(line) <= width, `${width}: ${line}`);
  }
});
