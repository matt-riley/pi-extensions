import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import * as attention from "../attention.mjs";
import { validateRequest } from "../../../shared/systemone-request.mjs";

const job = (id, output = "Server ready on port 3000") => ({
  id,
  output,
  command: "npm run dev",
  status: "running",
  owner: "agent",
  watch: "the server is ready to accept requests",
});
const answer = (value) => ({ type: "noul", noul: value });

test("one validated request batches independent watch conditions with bounded evidence", async () => {
  const calls = [];
  const result = await attention.judgeWatches({
    jobs: [job("a", "x".repeat(8000)), job("b", "Build failed")],
    ask: async (request) => {
      validateRequest(request);
      calls.push(request);
      return { answers: { watch_0: answer(0.92), watch_1: answer(0.2) } };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(Object.keys(calls[0].questions).length, 2);
  assert.equal(calls[0].state.jobs[0].output.length, 4000);
  assert.deepEqual(result, [
    { id: "a", probability: 0.92 },
    { id: "b", probability: 0.2 },
  ]);
});

test("invalid or missing model answers stay unknown, never observed success", async () => {
  const result = await attention.judgeWatches({
    jobs: [job("a"), job("b"), job("c")],
    ask: async () => ({
      answers: {
        watch_0: { type: "noul", noul: 2 },
        watch_1: { type: "choice", choice: "passed" },
      },
    }),
  });
  assert.deepEqual(
    result.map((item) => item.probability),
    [null, null, null],
  );
});

async function watcher(t, ask, options = {}) {
  const jobs = new EventEmitter();
  const live = new Map();
  jobs.read = (id) => {
    if (!live.has(id)) throw new Error("Unknown job");
    return live.get(id);
  };
  jobs.list = () => [...live.values()];
  const alerts = [],
    unavailable = [];
  const close = attention.watchJobs(jobs, {
    ask,
    debounceMs: 5,
    minIntervalMs: 0,
    onAlert: (item, probability) => alerts.push({ item, probability }),
    onUnavailable: (message) => unavailable.push(message),
    ...options,
  });
  t.after(close);
  return {
    alerts,
    unavailable,
    close,
    forget: (id) => live.delete(id),
    output(item) {
      live.set(item.id, item);
      jobs.emit("output", { id: item.id });
    },
  };
}

test("unwatched output makes no request; a qualifying condition alerts only once", async (t) => {
  let calls = 0;
  const h = await watcher(t, async () => {
    calls++;
    return { answers: { watch_0: answer(0.94) } };
  });
  h.output({ ...job("unwatched"), watch: null });
  await delay(20);
  assert.equal(calls, 0);
  h.output(job("a"));
  h.output(job("a"));
  await delay(30);
  assert.equal(calls, 1);
  assert.equal(h.alerts.length, 1);
  h.output(job("a", "Server ready again"));
  await delay(20);
  assert.equal(calls, 1);
});

test("uncertain answers stay quiet and identical excerpts are not judged again", async (t) => {
  let calls = 0;
  const h = await watcher(t, async () => {
    calls++;
    return { answers: { watch_0: answer(0.6) } };
  });
  h.output(job("a"));
  await delay(25);
  h.output(job("a"));
  await delay(25);
  assert.equal(calls, 1);
  assert.equal(h.alerts.length, 0);
});

test("stale answers and human-owned or completed jobs cannot trigger attention", async (t) => {
  let complete;
  const pending = new Promise((done) => (complete = done));
  let calls = 0;
  const h = await watcher(t, async () => {
    calls++;
    return pending;
  });
  h.output(job("a", "Starting"));
  await delay(20);
  h.output({ ...job("a", "Now changed"), owner: "human" });
  h.output({ ...job("b"), status: "exited" });
  complete({ answers: { watch_0: answer(0.99) } });
  await delay(25);
  assert.equal(calls, 1);
  assert.equal(h.alerts.length, 0);
});

test("takeover and release cannot revive an in-flight answer from before human input", async (t) => {
  let finish, started;
  const waiting = new Promise((done) => {
    finish = done;
  });
  const began = new Promise((done) => {
    started = done;
  });
  const h = await watcher(t, async () => {
    started();
    return waiting;
  });
  h.output({ ...job("a"), interacted: false });
  await began;
  h.output({ ...job("a"), owner: "human", interacted: true });
  h.output({ ...job("a"), owner: "agent", interacted: true });
  finish({ answers: { watch_0: answer(0.99) } });
  await delay(25);
  assert.equal(h.alerts.length, 0, "human input must cancel automatic semantic attention");
});

test("service failure reports an unavailable watch once without killing the process", async (t) => {
  let calls = 0;
  const h = await watcher(t, async () => {
    calls++;
    throw new Error("offline");
  });
  h.output(job("a"));
  await delay(25);
  h.output(job("a", "more output"));
  await delay(25);
  assert.equal(calls, 1);
  assert.equal(h.unavailable.length, 1);
  assert.match(h.unavailable[0], /offline/);
  assert.equal(h.alerts.length, 0);
});

test("forgotten jobs cannot crash queued or in-flight watches", async (t) => {
  let calls = 0,
    finish;
  const h = await watcher(t, async () => {
    calls++;
    return new Promise((done) => {
      finish = done;
    });
  });
  h.output(job("queued"));
  h.forget("queued");
  await delay(25);
  assert.equal(calls, 0);
  h.output(job("in-flight"));
  await delay(25);
  h.forget("in-flight");
  finish({ answers: { watch_0: answer(0.99) } });
  await delay(25);
  assert.equal(h.alerts.length, 0);
  assert.equal(h.unavailable.length, 0);
});

test("a fixed request budget and shutdown stop subsequent judgments", async (t) => {
  let calls = 0;
  const h = await watcher(
    t,
    async () => {
      calls++;
      return { answers: { watch_0: answer(0.01) } };
    },
    { maxCalls: 1 },
  );
  h.output(job("a", "one"));
  await delay(25);
  h.output(job("a", "two"));
  await delay(25);
  assert.equal(calls, 1);
  assert.match(h.unavailable[0], /budget/i);
  h.close();
  h.output(job("b"));
  await delay(15);
  assert.equal(calls, 1);
});
