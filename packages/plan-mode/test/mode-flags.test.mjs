import { test } from "node:test";
import assert from "node:assert/strict";
import { isReadOnlyMode, setReadOnlyMode } from "../../../shared/mode-flags.mjs";

test("defaults to false", () => {
  // Reset first in case another test file in the same process run flipped it.
  setReadOnlyMode(false);
  assert.equal(isReadOnlyMode(), false);
});

test("setReadOnlyMode toggles isReadOnlyMode", () => {
  setReadOnlyMode(true);
  assert.equal(isReadOnlyMode(), true);
  setReadOnlyMode(false);
  assert.equal(isReadOnlyMode(), false);
});

test("setReadOnlyMode coerces truthy/falsy values to boolean", () => {
  setReadOnlyMode(1);
  assert.equal(isReadOnlyMode(), true);
  setReadOnlyMode(0);
  assert.equal(isReadOnlyMode(), false);
  setReadOnlyMode(undefined);
  assert.equal(isReadOnlyMode(), false);
});
