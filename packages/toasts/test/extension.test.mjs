import assert from "node:assert/strict";
import { test } from "node:test";
import {
  overlayVisible,
  readToastSettings,
  restoreNotify,
  timeoutMs,
  wrapNotify,
} from "../extension.mjs";

test("readToastSettings defaults and env overrides", () => {
  const s = readToastSettings({});
  assert.equal(s.capture, true);
  assert.equal(s.width, 44);
  assert.equal(s.maxVisible, 3);
  assert.equal(s.timeout.info, 4000);
  assert.equal(s.timeout.warning, 6000);
  assert.equal(s.timeout.error, 8000);

  const off = readToastSettings({
    PI_TOAST_CAPTURE: "0",
    PI_TOAST_WIDTH: "32",
    PI_TOAST_MAX_VISIBLE: "2",
  });
  assert.equal(off.capture, false);
  assert.equal(off.width, 32);
  assert.equal(off.maxVisible, 2);
});

test("timeoutMs picks severity defaults", () => {
  const settings = readToastSettings({});
  assert.equal(timeoutMs("info", settings), 4000);
  assert.equal(timeoutMs("warning", settings), 6000);
  assert.equal(timeoutMs("error", settings), 8000);
  assert.equal(timeoutMs(undefined, settings), 4000);
});

test("overlayVisible hides narrow or short terminals", () => {
  assert.equal(overlayVisible(29, 20), false);
  assert.equal(overlayVisible(30, 7), false);
  assert.equal(overlayVisible(30, 8), true);
});

test("wrapNotify forwards to queue with severity timeouts", () => {
  const shown = [];
  const queue = { show: (text, severity, ms) => shown.push({ text, severity, ms }) };
  const settings = readToastSettings({});
  const notify = wrapNotify(queue, settings);
  notify("hello", "warning");
  assert.deepEqual(shown, [{ text: "hello", severity: "warning", ms: 6000 }]);
});

test("restoreNotify only swaps when our wrapper is still installed", () => {
  const original = () => {};
  const installed = () => {};
  const other = () => {};
  const ui = { notify: installed };
  restoreNotify(ui, original, installed);
  assert.equal(ui.notify, original);
  ui.notify = other;
  restoreNotify(ui, original, installed);
  assert.equal(ui.notify, other);
});
