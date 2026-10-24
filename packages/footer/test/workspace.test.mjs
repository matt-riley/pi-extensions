import assert from "node:assert/strict";
import { test } from "node:test";

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
  const full = workspaceLine(data, 100, paint);
  assert.match(full, /repo/);
  assert.match(full, /main/);
  assert.match(full, /working/);
  assert.match(full, /42%/);
  assert.match(full, /long-model-name/);
  const narrow = workspaceLine(data, 28, paint);
  assert.match(narrow, /repo/);
  assert.match(narrow, /main/);
  assert.match(narrow, /working/);
  assert.doesNotMatch(narrow, /long-model-name/);
  for (const width of [0, 1, 2, 8, 12, 20, 40]) {
    assert.ok(workspaceLine(data, width, paint).length <= width);
  }
});

test("workspace layout measures CJK, combining marks and emoji in terminal columns", async () => {
  const { workspaceLine, visibleWidth, truncateToWidth } = await import("../workspace.mjs");
  assert.equal(visibleWidth("工作"), 4);
  assert.equal(visibleWidth("e\u0301"), 1);
  assert.equal(visibleWidth("🚀"), 2);
  assert.equal(visibleWidth("🇦🇺"), 2);
  assert.equal(visibleWidth("©"), 1);
  assert.equal(visibleWidth("©️"), 2);
  assert.equal(truncateToWidth("工作abc", 4), "工…");
  for (const width of [0, 1, 2, 6, 12, 24, 50]) {
    const text = workspaceLine(
      { project: "工作🚀", branch: "修正", state: "ready", model: "模型" },
      width,
      (_c, s) => s,
    );
    assert.ok(visibleWidth(text) <= width, text);
  }
});

test("footer never prints terminal controls from project/model names", async () => {
  const { workspaceLine } = await import("../workspace.mjs");
  const text = workspaceLine(
    { project: "a\nb\u001b[2J", branch: "main", state: "ready", model: "x" },
    80,
    (_c, s) => s,
  );
  assert.ok(!text.includes("\n") && !text.includes(String.fromCharCode(27)));
  assert.match(text, /ab/);
});
