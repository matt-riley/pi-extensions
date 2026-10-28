import assert from "node:assert/strict";
import { test } from "node:test";
import { tui } from "./tui-fixture.mjs";

test("work status distinguishes planning, working and ready without claiming verification", async () => {
  const { workLabel } = await import("../workspace.mjs");
  assert.equal(workLabel(false, new Map()), "ready");
  assert.equal(workLabel(true, new Map()), "working");
  assert.equal(workLabel(false, new Map([["plan-mode", "plan (read-only)"]])), "planning");
  assert.equal(workLabel(true, new Map([["plan-mode", "plan (read-only)"]])), "planning");
});

test("workspace and work state survive width pressure before model/accounting details", async () => {
  const { workspaceLine } = await import("../workspace.mjs");
  const data = {
    project: "repo",
    branch: "main",
    state: "working",
    model: "provider/long-model-name",
    level: "high",
    percent: 42,
  };
  const paint = (_color, text) => text;
  const full = workspaceLine(data, 100, paint, tui);
  assert.match(full, /repo/);
  assert.match(full, /main/);
  assert.match(full, /working/);
  assert.match(full, /42%/);
  assert.match(full, /long-model-name/);
  const narrow = workspaceLine(data, 28, paint, tui);
  assert.match(narrow, /repo/);
  assert.match(narrow, /main/);
  assert.match(narrow, /working/);
  assert.doesNotMatch(narrow, /long-model-name/);
  for (const width of [0, 1, 2, 8, 12, 20, 40]) {
    assert.ok(workspaceLine(data, width, paint, tui).length <= width);
  }
});

test("workspace layout keeps CJK and emoji names within the measured width", async () => {
  const { workspaceLine } = await import("../workspace.mjs");
  for (const width of [0, 1, 2, 6, 12, 24, 50]) {
    const text = workspaceLine(
      { project: "工作🚀", branch: "修正", state: "ready", model: "模型" },
      width,
      (_c, s) => s,
      tui,
    );
    assert.ok(tui.visibleWidth(text) <= width, text);
  }
});

test("footer never prints terminal controls from project/model names", async () => {
  const { workspaceLine } = await import("../workspace.mjs");
  const text = workspaceLine(
    { project: "a\nb\u001b[2J", branch: "main", state: "ready", model: "x" },
    80,
    (_c, s) => s,
    tui,
  );
  assert.ok(!text.includes("\n") && !text.includes(String.fromCharCode(27)));
  assert.match(text, /ab/);
});

test("workspace layout fits the width measured by pi-tui's helpers, not its own count", async () => {
  const { workspaceLine } = await import("../workspace.mjs");
  // Thai and Devanagari clusters are wider in pi-tui than a hand count makes them.
  const data = {
    project: "क्षिक्षि",
    branch: "กำกำ",
    state: "ready",
    model: "m/ภาษา",
    level: "high",
  };
  for (const width of [1, 4, 8, 12, 16, 24, 40]) {
    const text = workspaceLine(data, width, (_c, s) => s, tui);
    assert.ok(tui.visibleWidth(text) <= width, `${width}: ${JSON.stringify(text)}`);
  }
});

test("a truncated segment keeps its theme colour through the ellipsis", async () => {
  const { workspaceLine } = await import("../workspace.mjs");
  // pi-tui puts a full reset before its ellipsis; inside a coloured segment
  // that would end the theme colour early and leave the ellipsis unstyled.
  const paint = (_color, s) => `\u001b[90m${s}\u001b[39m`;
  const text = workspaceLine(
    { project: "a-very-long-project-name", state: "ready" },
    16,
    paint,
    tui,
  );
  assert.equal(text, "\u001b[90ma-very-lo…\u001b[39m \u001b[90mready\u001b[39m");
});
