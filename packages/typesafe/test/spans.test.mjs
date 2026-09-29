import { test } from "node:test";
import assert from "node:assert/strict";

import {
  excerpt,
  mapPool,
  rateCandidates,
  splitWindows,
  topIndices,
} from "../../../shared/spans.mjs";

test("splitWindows uses 1-based inclusive bounds and coarsens past the cap", () => {
  const text = Array.from({ length: 60 }, (_, i) => `l${i}`).join("\n");
  const windows = splitWindows(text);
  assert.deepEqual([windows[0].start, windows[0].end, windows[2].end], [1, 25, 60]);
  assert.ok(splitWindows(text, { size: 1, maxWindows: 5 }).length <= 5);
});

test("excerpt keeps head and tail", () => {
  const out = excerpt(`${"h".repeat(100)}${"t".repeat(100)}`, 40);
  assert.ok(out.startsWith("hhhh") && out.endsWith("tttt") && out.length <= 44);
});

test("mapPool keeps input order under bounded concurrency", async () => {
  let running = 0;
  let peak = 0;
  const out = await mapPool(
    [1, 2, 3, 4, 5, 6],
    async (n) => {
      peak = Math.max(peak, ++running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return n * 2;
    },
    2,
  );
  assert.deepEqual(out, [2, 4, 6, 8, 10, 12]);
  assert.ok(peak <= 2);
});

test("topIndices ignores unusable ratings and prefers the later index on a tie", () => {
  assert.deepEqual(topIndices([null, 0.9, 0.4, 0.9], { max: 2 }), [3, 1]);
  assert.deepEqual(topIndices([null, null]), []);
});

test("rateCandidates asks once per candidate, each with only its own text", async () => {
  const seen = [];
  const ask = async ({ state, questions }) => {
    seen.push({ state, questions });
    return { answers: { rating: { type: "noul", noul: state.candidate === "b" ? 0.9 : 0.1 } } };
  };
  const ratings = await rateCandidates({
    context: "g",
    candidates: ["a", "b", "c"],
    instruction: "?",
    criteria: { true: "t", false: "f" },
    ask,
  });
  assert.deepEqual(ratings, [0.1, 0.9, 0.1]);
  assert.equal(seen.length, 3);
  for (const { state, questions } of seen) {
    assert.equal(state.context, "g");
    assert.equal(typeof state.candidate, "string"); // never the whole list
    assert.match(questions.rating.instructions, /`candidate`/);
    assert.deepEqual(questions.rating.criteria, { true: "t", false: "f" });
  }
  assert.deepEqual(
    await rateCandidates({ context: "g", candidates: [], instruction: "?", ask }),
    [],
  );
});
