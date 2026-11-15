import assert from "node:assert/strict";
import test from "node:test";
import { sleep } from "../index.ts";

test("sleep removes its abort listener when the timer wins", async () => {
  let listeners = 0;
  const signal = {
    aborted: false,
    addEventListener: () => {
      listeners++;
    },
    removeEventListener: () => {
      listeners--;
    },
  };
  await sleep(1, signal);
  assert.equal(listeners, 0);
});

test("sleep wakes early when the signal aborts", async () => {
  const controller = new AbortController();
  const started = Date.now();
  const pending = sleep(5000, controller.signal);
  controller.abort();
  await pending;
  assert.ok(Date.now() - started < 1000, "abort should resolve without waiting the timer");
});
