import { test } from "node:test";
import assert from "node:assert/strict";
import { allocateItemBudget, chargeBudget } from "../batch.mjs";

test("allocateItemBudget: early small pages leave budget for later items", () => {
  // Regression for the starvation bug: with defaults (maxChars 60000,
  // totalMaxChars 300000) upfront reservation gave items 6+ a 0 budget even
  // though items 1-5 only used a fraction of their reservation. Charging by
  // actual content used means the 6th item still sees real headroom.
  let remaining = 300000;
  const requestMaxChars = 60000;

  for (let i = 0; i < 5; i++) {
    const allocation = allocateItemBudget(remaining, requestMaxChars);
    assert.equal(allocation.exhausted, false);
    assert.equal(allocation.cap, 60000);
    // Each of these 5 pages only actually used 500 chars of content.
    remaining = chargeBudget(remaining, 500);
  }

  // Old behavior: 5 * 60000 reserved upfront == 300000, so item 6 would get
  // cap 0. New behavior: only 5 * 500 = 2500 was actually consumed.
  assert.equal(remaining, 300000 - 5 * 500);
  const sixth = allocateItemBudget(remaining, requestMaxChars);
  assert.equal(sixth.exhausted, false);
  assert.equal(sixth.cap, 60000);
});

test("allocateItemBudget: budget exhaustion mid-batch produces a skip signal", () => {
  let remaining = 300000;
  const requestMaxChars = 60000;

  // Five items that each consume their full cap exhaust the budget exactly.
  for (let i = 0; i < 5; i++) {
    const allocation = allocateItemBudget(remaining, requestMaxChars);
    assert.equal(allocation.exhausted, false);
    remaining = chargeBudget(remaining, allocation.cap);
  }
  assert.equal(remaining, 0);

  // A 6th item now starts with the budget already at 0: skip it, don't fetch
  // with cap 0.
  const sixth = allocateItemBudget(remaining, requestMaxChars);
  assert.equal(sixth.exhausted, true);
  assert.equal(sixth.cap, 0);

  // Once exhausted it stays exhausted for subsequent items too.
  const seventh = allocateItemBudget(remaining, requestMaxChars);
  assert.equal(seventh.exhausted, true);
});

test("allocateItemBudget: a single item larger than the remaining budget gets capped, not skipped", () => {
  const allocation = allocateItemBudget(10000, 1_000_000);
  assert.equal(allocation.exhausted, false);
  assert.equal(allocation.cap, 10000);

  // Remaining budget still positive but smaller than the item's own cap.
  const allocation2 = allocateItemBudget(1, 60000);
  assert.equal(allocation2.exhausted, false);
  assert.equal(allocation2.cap, 1);
});

test("chargeBudget: deducts actual usage, floors at zero, tolerates bad input", () => {
  assert.equal(chargeBudget(1000, 400), 600);
  assert.equal(chargeBudget(1000, 5000), 0); // never goes negative
  assert.equal(chargeBudget(1000, -50), 1000); // negative usage treated as 0
  assert.equal(chargeBudget(1000, NaN), 1000); // non-finite treated as 0
  assert.equal(chargeBudget(0, 100), 0);
});
