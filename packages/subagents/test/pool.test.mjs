import { test } from "node:test";
import assert from "node:assert/strict";
import { createPool } from "../pool.mjs";

test("fifth spawn queues; release starts the next queued", async () => {
  const pool = createPool({ maxConcurrent: 4 });
  const slots = ["a", "b", "c", "d"].map((description) => pool.acquire("scout", { description }));
  for (const slot of slots) {
    assert.equal(slot.entry.status, "running");
    await slot.ready;
  }
  const queued = pool.acquire("reviewer", { description: "tests" });
  assert.equal(queued.entry.status, "queued");
  assert.equal(pool.queuedCount(), 1);
  assert.equal(pool.runningCount(), 4);

  pool.release(slots[0].entry.id);
  const started = await queued.ready;
  assert.equal(started.status, "running");
  assert.equal(started.id, "reviewer");
  assert.equal(pool.queuedCount(), 0);
  assert.equal(pool.runningCount(), 4);
});

test("stop queued never starts", async () => {
  const pool = createPool({ maxConcurrent: 1 });
  const running = pool.acquire("scout", { description: "live" });
  const queued = pool.acquire("reviewer", { description: "wait" });
  assert.equal(queued.entry.status, "queued");

  const stopped = pool.stop(queued.entry.id);
  assert.equal(stopped, true);
  const result = await queued.ready;
  assert.equal(result.stoppedBeforeStart, true);
  assert.equal(pool.queuedCount(), 0);
  assert.equal(pool.get(queued.entry.id), undefined);

  pool.release(running.entry.id);
  assert.equal(pool.runningCount(), 0);
});

test("stop running calls the abort hook", () => {
  const pool = createPool({ maxConcurrent: 1 });
  const { entry } = pool.acquire("scout", { description: "live" });
  let aborted = false;
  pool.update(entry.id, {
    abort: () => {
      aborted = true;
    },
  });
  assert.equal(pool.stop(entry.id), true);
  assert.equal(aborted, true);
});

test("ids increment per type and do not reuse after release", () => {
  const pool = createPool({ maxConcurrent: 4 });
  const first = pool.acquire("Scout", {});
  const second = pool.acquire("scout", {});
  assert.equal(first.entry.id, "scout");
  assert.equal(second.entry.id, "scout-2");
  pool.release(first.entry.id);
  const third = pool.acquire("SCOUT", {});
  assert.equal(third.entry.id, "scout-3");
});
