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

test("stop before abort is wired fires as soon as abort lands", () => {
  const pool = createPool({ maxConcurrent: 1 });
  const { entry } = pool.acquire("scout", { description: "starting" });
  // Session still being created: no abort hook yet. The stop must not no-op.
  assert.equal(pool.stop(entry.id), true);
  assert.equal(pool.get(entry.id)?.stopRequested, true);

  let aborted = false;
  pool.update(entry.id, {
    abort: () => {
      aborted = true;
    },
  });
  assert.equal(aborted, true);
  assert.equal(pool.get(entry.id)?.stopRequested, false);
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

const writer = (pool, description = "edit") => pool.acquire("worker", { description, write: true });
const reader = (pool, description = "look") => pool.acquire("scout", { description });
const writersRunning = (pool) =>
  pool.list().filter((entry) => entry.write && entry.status === "running").length;

test("two writers never run at once, even with free slots", async () => {
  const pool = createPool({ maxConcurrent: 4 });
  const first = writer(pool, "one");
  const second = writer(pool, "two");
  assert.equal(first.entry.status, "running");
  assert.equal(second.entry.status, "queued");
  assert.equal(writersRunning(pool), 1);
  assert.equal(pool.runningCount(), 1);

  pool.release(first.entry.id);
  const started = await second.ready;
  assert.equal(started.status, "running");
  assert.equal(writersRunning(pool), 1);
});

test("read-only children stay parallel, including beside a running writer", async () => {
  const pool = createPool({ maxConcurrent: 4 });
  const w = writer(pool);
  const readers = [reader(pool, "a"), reader(pool, "b"), reader(pool, "c")];
  assert.equal(w.entry.status, "running");
  for (const r of readers) assert.equal(r.entry.status, "running");
  assert.equal(pool.runningCount(), 4);
});

test("a queued writer does not hold back readers that arrive after it", async () => {
  const pool = createPool({ maxConcurrent: 4 });
  const first = writer(pool, "one");
  const second = writer(pool, "two");
  const late = reader(pool, "late");
  assert.equal(second.entry.status, "queued");
  assert.equal(late.entry.status, "running");
  assert.equal(first.entry.status, "running");
});

test("queued writers start in arrival order, one per release", async () => {
  const pool = createPool({ maxConcurrent: 4 });
  const first = writer(pool, "one");
  const second = writer(pool, "two");
  const third = writer(pool, "three");
  const between = reader(pool, "between");
  assert.deepEqual(
    [first, second, third, between].map((slot) => slot.entry.status),
    ["running", "queued", "queued", "running"],
  );

  pool.release(first.entry.id);
  assert.equal(second.entry.status, "running");
  assert.equal(third.entry.status, "queued");
  assert.equal(writersRunning(pool), 1);

  pool.release(between.entry.id); // a reader finishing does not free the writer lane
  assert.equal(third.entry.status, "queued");

  pool.release(second.entry.id);
  assert.equal(third.entry.status, "running");
  assert.equal(writersRunning(pool), 1);
});

test("a queued writer still waits for a free slot", async () => {
  const pool = createPool({ maxConcurrent: 2 });
  const a = reader(pool, "a");
  const b = reader(pool, "b");
  const w = writer(pool);
  assert.equal(w.entry.status, "queued");
  pool.release(a.entry.id);
  assert.equal(w.entry.status, "running");
  assert.equal(pool.runningCount(), 2);
  pool.release(b.entry.id);
});

test("stopping the running writer or a queued one frees the lane in order", async () => {
  const pool = createPool({ maxConcurrent: 4 });
  const first = writer(pool, "one");
  const second = writer(pool, "two");
  const third = writer(pool, "three");

  assert.equal(pool.stop(second.entry.id), true);
  assert.equal((await second.ready).stoppedBeforeStart, true);
  assert.equal(third.entry.status, "queued");

  pool.release(first.entry.id);
  assert.equal(third.entry.status, "running");
  assert.equal(writersRunning(pool), 1);
});

test("a writer's queued status reaches the widget count", () => {
  const pool = createPool({ maxConcurrent: 4 });
  writer(pool, "one");
  writer(pool, "two");
  assert.equal(pool.queuedCount(), 1);
  assert.equal(pool.runningCount(), 1);
});
