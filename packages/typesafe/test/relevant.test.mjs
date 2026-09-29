import { test } from "node:test";
import assert from "node:assert/strict";

import { formatRanges, selectRelevantRanges } from "../relevant.mjs";

const noul = (value) => ({ type: "noul", noul: value });

/** Rates a candidate 0.9 when it contains the marker, else 0.1. */
const markerAsk =
  (marker) =>
  async ({ state }) => ({
    answers: { rating: noul(state.candidate.includes(marker) ? 0.9 : 0.1) },
  });

const fileWith = (total, markerLine) =>
  Array.from({ length: total }, (_, i) =>
    i + 1 === markerLine ? "RETRY_MARK backoff" : `line ${i + 1}`,
  ).join("\n");

const select = (text, extra = {}) =>
  selectRelevantRanges({
    text,
    path: "src/a.ts",
    goal: "retry backoff",
    ask: markerAsk("RETRY_MARK"),
    ...extra,
  });

test("a short file comes back in full without asking Jev", async () => {
  const ask = async () => assert.fail("should not be called");
  const result = await selectRelevantRanges({
    text: fileWith(50, 10),
    path: "a.ts",
    goal: "g",
    ask,
  });
  assert.equal(result.whole, true);
  assert.match(formatRanges({ path: "a.ts", ...result }), /short file, shown in full/);
});

test("a large file returns only the padded window around the relevant lines", async () => {
  const result = await select(fileWith(300, 150));
  assert.equal(result.ranges.length, 1);
  const [{ start, end }] = result.ranges;
  assert.ok(start <= 150 && end >= 150 && end - start < 60);
  const text = formatRanges({ path: "src/a.ts", ...result });
  assert.match(text, /── src\/a\.ts:\d+-\d+ ──/);
  assert.match(text, /150 {2}RETRY_MARK backoff/);
  assert.doesNotMatch(text, /\bline 5\b/);
  assert.match(text, /300 lines total; showing 1 range\(s\)/);
});

test("a big winning window is refined to a tight range", async () => {
  const result = await select(fileWith(6000, 3001));
  const [{ start, end }] = result.ranges;
  assert.ok(start <= 3001 && end >= 3001);
  assert.ok(end - start < 40, `range too wide: ${end - start}`);
});

test("nothing relevant says so and points at read; unusable ratings throw", async () => {
  const none = await select(fileWith(300, 150), { ask: markerAsk("NEVER") });
  assert.match(
    formatRanges({ path: "src/a.ts", ...none }),
    /No range of src\/a\.ts \(300 lines\) was judged relevant/,
  );
  const allNull = async () => ({ answers: { rating: noul(null) } });
  await assert.rejects(select(fileWith(300, 150), { ask: allNull }), /no usable ratings/);
});

test("adjacent and overlapping ranges merge, and output is capped", async () => {
  const everything = async () => ({ answers: { rating: noul(0.9) } });
  const result = await select(fileWith(2000, 1), { ask: everything, maxRanges: 8 });
  const starts = result.ranges.map((r) => r.start);
  assert.deepEqual(
    starts,
    [...starts].sort((a, b) => a - b),
  );
  for (let i = 1; i < result.ranges.length; i++)
    assert.ok(result.ranges[i].start > result.ranges[i - 1].end + 1);
  const shown = formatRanges({ path: "a.ts", ...result })
    .split("\n")
    .filter((l) => /^\s*\d+ {2}/.test(l));
  assert.ok(shown.length <= 400);
});
