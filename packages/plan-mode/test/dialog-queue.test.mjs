import { test } from "node:test";
import assert from "node:assert/strict";
import { createDialogQueue } from "../dialog-queue.mjs";

test("runs dialogs FIFO, each waiting for the previous to settle", async () => {
  const enqueue = createDialogQueue();
  const order = [];
  let releaseFirst;
  const gate = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = enqueue(async () => {
    await gate; // simulates a slow user answering the first dialog
    order.push(1);
    return "answer 1";
  });
  const second = enqueue(async () => {
    order.push(2);
    return "answer 2";
  });
  const third = enqueue(async () => {
    order.push(3);
    return "answer 3";
  });

  // Later calls must not start while the first dialog is still open.
  assert.deepEqual(order, []);

  releaseFirst();
  assert.equal(await first, "answer 1");
  assert.equal(await second, "answer 2");
  assert.equal(await third, "answer 3");
  assert.deepEqual(order, [1, 2, 3]);
});

test("a rejected dialog does not block later dialogs", async () => {
  const enqueue = createDialogQueue();
  const second = enqueue(() => Promise.reject(new Error("dialog blew up")));
  const third = enqueue(async () => "ok");
  await assert.rejects(second, /dialog blew up/);
  assert.equal(await third, "ok");
});

test("results resolve in scheduling order", async () => {
  const enqueue = createDialogQueue();
  const results = await Promise.all([
    enqueue(async () => "a"),
    enqueue(async () => "b"),
    enqueue(async () => "c"),
  ]);
  assert.deepEqual(results, ["a", "b", "c"]);
});

test("queue survives a mix of successes and failures in order", async () => {
  const enqueue = createDialogQueue();
  const results = [];
  const calls = [1, 2, 3].map((n) =>
    enqueue(async () => {
      if (n === 2) throw new Error(`boom ${n}`);
      return `ok ${n}`;
    }),
  );
  results.push(await calls[0]);
  await assert.rejects(calls[1], /boom 2/);
  results.push(await calls[2]);
  assert.deepEqual(results, ["ok 1", "ok 3"]);
});
