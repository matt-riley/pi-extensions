import assert from "node:assert/strict";
import { test } from "node:test";
import { tui, visibleWidth } from "../../footer/test/tui-fixture.mjs";
import { createToastQueue, createToastStack, oneLine, wrap } from "../toast.mjs";

const plain = (_t, s) => s;
const ansi = (_t, s) => `\x1b[31m${s}\x1b[39m`;

class FakeClock {
  constructor() {
    this.now = 0;
    this.jobs = [];
    this.n = 0;
  }
  setTimeout(fn, ms) {
    const job = { at: this.now + ms, fn, id: ++this.n, live: true };
    this.jobs.push(job);
    return job;
  }
  clearTimeout(h) {
    h.live = false;
  }
  advance(ms) {
    this.now += ms;
    for (const job of this.jobs.filter((item) => item.live && item.at <= this.now)) {
      job.live = false;
      job.fn();
    }
  }
  get pending() {
    return this.jobs.filter((item) => item.live).length;
  }
}

test("every line fits width, with ANSI, CJK and emoji, at widths 1-80", () => {
  const s = createToastStack(ansi, tui, 3);
  s.setToasts([
    {
      id: 1,
      text: "Build finished ✅ in 12s — 日本語のテキストも 👩‍👩‍👧 OK",
      severity: "info",
    },
    { id: 2, text: "x".repeat(300), severity: "error" },
  ]);
  for (let w = 1; w <= 80; w++) {
    s.invalidate();
    for (const line of s.render(w))
      assert.ok(visibleWidth(line) <= w, `width ${w}: ${visibleWidth(line)}`);
  }
});

test("card is boxed and capped at maxLines with an ellipsis", () => {
  const s = createToastStack(plain, tui, 2);
  s.setToasts([
    { id: 1, text: "one two three four five six seven eight nine ten", severity: "info" },
  ]);
  const lines = s.render(16);
  assert.equal(lines.length, 4);
  assert.ok(lines[0].startsWith("╭") && lines[3].startsWith("╰"));
  assert.ok(lines[2].includes("…") || lines[2].includes("..."));
});

test("render is cached by width until invalidate/setToasts", () => {
  const s = createToastStack(plain, tui);
  s.setToasts([{ id: 1, text: "hi", severity: "info" }]);
  const a = s.render(20);
  assert.equal(s.render(20), a);
  s.setToasts([]);
  assert.deepEqual(s.render(20), []);
});

test("oneLine strips ESC and newlines", () => {
  assert.equal(oneLine("a\x1b[2Jb\nc\r\td"), "a [2Jb c d");
  assert.deepEqual(wrap("", 10, 3, tui), [""]);
});

test("toasts expire after their own timeout and the list empties", () => {
  const clock = new FakeClock();
  const seen = [];
  const q = createToastQueue((t) => seen.push(t.length), { maxVisible: 3, clock });
  q.show("a", "info", 1000);
  q.show("b", "info", 3000);
  clock.advance(1000);
  assert.equal(q.size, 1);
  clock.advance(2000);
  assert.equal(q.size, 0);
  assert.deepEqual(seen, [1, 2, 1, 0]);
});

test("maxVisible evicts the oldest and cancels its timer", () => {
  const clock = new FakeClock();
  const q = createToastQueue(() => {}, { maxVisible: 2, clock });
  q.show("a");
  q.show("b");
  q.show("c");
  assert.equal(q.size, 2);
  assert.equal(clock.pending, 2);
});

test("dispose cancels timers and stale timers never call onChange", () => {
  const clock = new FakeClock();
  let calls = 0;
  const q = createToastQueue(() => calls++, { maxVisible: 3, clock });
  q.show("a", "info", 1000);
  q.dispose();
  clock.advance(5000);
  assert.equal(calls, 1);
  assert.equal(clock.pending, 0);
  q.show("after");
  assert.equal(calls, 1);
});

test("onChange runs on every show for streaming redraw hooks", () => {
  const clock = new FakeClock();
  let n = 0;
  const q = createToastQueue(() => n++, { maxVisible: 3, clock });
  q.show("one");
  q.show("two");
  assert.equal(n, 2);
});
