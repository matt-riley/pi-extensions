import { test } from "node:test";
import assert from "node:assert/strict";

import { attachContext, clampContext } from "../hit-context.mjs";

const FILE = ["one", "two", "three", "four", "five", "six", "seven"].join("\n");
const hit = (rel, lineNo) => ({ rel, lineNo, col: 1, text: "x" });
const around = (h) => h.around.map((line) => line.n);

test("clampContext keeps a whole number between 0 and 10", () => {
  assert.equal(clampContext(undefined), 0);
  assert.equal(clampContext("abc"), 0);
  assert.equal(clampContext(-3), 0);
  assert.equal(clampContext(2.9), 2);
  assert.equal(clampContext(99), 10);
});

test("a window is the match plus N lines each side, clipped at the file edges", async () => {
  const { hits } = await attachContext({
    hits: [hit("a.ts", 4), hit("a.ts", 1), hit("a.ts", 7)],
    context: 2,
    readFile: async () => FILE,
  });
  assert.deepEqual(around(hits[0]), [2, 3, 4, 5, 6]);
  assert.deepEqual(around(hits[1]), [1, 2, 3]);
  assert.deepEqual(around(hits[2]), [5, 6, 7]);
  assert.deepEqual(
    hits[0].around.map((line) => line.match),
    [false, false, true, false, false],
  );
  assert.equal(hits[0].around[2].text, "four");
});

test("the exact text is kept, indentation and all, and a very long line is cut visibly", async () => {
  const long = `  ${"x".repeat(400)}`;
  const { hits } = await attachContext({
    hits: [hit("a.ts", 2)],
    context: 1,
    readFile: async () => `\tfirst\n${long}\r\nlast`,
  });
  assert.equal(hits[0].around[0].text, "\tfirst");
  assert.ok(hits[0].around[1].text.endsWith("…"));
  assert.ok(hits[0].around[1].text.length <= 201);
  assert.equal(hits[0].around[2].text, "last", "a CRLF line ending is not part of the text");
});

test("each file is read once however many hits it has", async () => {
  const reads = [];
  await attachContext({
    hits: [hit("a.ts", 2), hit("b.ts", 2), hit("a.ts", 5)],
    context: 1,
    readFile: async (rel) => {
      reads.push(rel);
      return FILE;
    },
  });
  assert.deepEqual(reads.sort(), ["a.ts", "b.ts"]);
});

test("context 0 reads nothing and changes nothing", async () => {
  let reads = 0;
  const input = [hit("a.ts", 2)];
  const result = await attachContext({
    hits: input,
    context: 0,
    readFile: async () => {
      reads++;
      return FILE;
    },
  });
  assert.equal(reads, 0);
  assert.equal(result.omitted, 0);
  assert.equal(result.hits[0].around, undefined);
});

test("a page that would be too long keeps early hits whole and counts the rest", async () => {
  const hits = [hit("a.ts", 4), hit("a.ts", 3), hit("a.ts", 5)];
  const result = await attachContext({ hits, context: 2, budget: 7, readFile: async () => FILE });
  assert.equal(result.hits[0].around.length, 5);
  assert.equal(result.hits[1].around, undefined);
  assert.equal(result.hits[2].around, undefined);
  assert.equal(result.omitted, 2);
});

test("an unreadable file leaves its hits as plain matches", async () => {
  const result = await attachContext({
    hits: [hit("gone.ts", 2)],
    context: 2,
    readFile: async () => null,
  });
  assert.equal(result.hits[0].around, undefined);
  assert.equal(result.omitted, 1);
});
