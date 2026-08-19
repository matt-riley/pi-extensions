import { test } from "node:test";
import assert from "node:assert/strict";
import { combineSignals } from "../combine-signals.mjs";

test("no signals -> undefined", () => {
  assert.equal(combineSignals([]), undefined);
  assert.equal(combineSignals([undefined, null]), undefined);
  assert.equal(combineSignals(), undefined);
});

test("single signal is passed through unchanged", () => {
  const controller = new AbortController();
  const combined = combineSignals([controller.signal, undefined]);
  assert.equal(combined, controller.signal);
});

test("either of two signals aborting aborts the combined signal", () => {
  const a = new AbortController();
  const b = new AbortController();
  const combined = combineSignals([a.signal, b.signal]);
  assert.equal(combined.aborted, false);
  a.abort();
  assert.equal(combined.aborted, true);
});

test("second signal alone can also abort the combined signal", () => {
  const a = new AbortController();
  const b = new AbortController();
  const combined = combineSignals([a.signal, b.signal]);
  assert.equal(combined.aborted, false);
  b.abort();
  assert.equal(combined.aborted, true);
});

test("undefined entries are filtered out", () => {
  const a = new AbortController();
  const combined = combineSignals([undefined, a.signal, null]);
  assert.equal(combined, a.signal);
});
