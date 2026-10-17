import assert from "node:assert/strict";
import test from "node:test";

import { buildQuestions, formatAnswer, routeAnswer, splitPassages } from "../answer.mjs";

const noul = (value) => ({ type: "noul", noul: value });

test("a page splits on blank lines into passage-sized blocks", () => {
  const { passages } = splitPassages("aaa\n\nbbb\n\nccc", { chars: 3 });
  assert.deepEqual(passages, ["aaa", "bbb", "ccc"]);
});

test("a page short enough to read whole stays one passage", () => {
  const { passages } = splitPassages("one\n\ntwo");
  assert.deepEqual(passages, ["one\n\ntwo"]);
});

test("a block with no blank lines is still cut up, not dropped", () => {
  const { passages } = splitPassages("x".repeat(25), { chars: 10 });
  assert.equal(passages.length, 3);
  assert.equal(passages.join("").length, 25);
});

test("passages past the cap merge instead of disappearing", () => {
  const text = Array.from({ length: 20 }, (_, index) => "block " + index).join("\n\n");
  const { passages } = splitPassages(text, { max: 4, chars: 20 });
  assert.equal(passages.length, 4);
  assert.match(passages.join("\n"), /block 0/);
  assert.match(passages.join("\n"), /block 19/);
});

test("a page past the character cap says it was cut", () => {
  const { truncated } = splitPassages("y".repeat(50), { maxChars: 20, chars: 10 });
  assert.equal(truncated, true);
  assert.equal(splitPassages("short").truncated, false);
});

test("every passage is asked about, plus whether the page answers at all", () => {
  const questions = buildQuestions(2);
  assert.deepEqual(Object.keys(questions).sort(), ["answered", "passage_0", "passage_1"]);
  assert.match(questions.passage_1.instructions, /`passages\.1\.text`/);
});

test("only passages over the threshold are returned, strongest first", () => {
  const passages = ["a", "b", "c"];
  const routed = routeAnswer(
    { answered: noul(0.9), passage_0: noul(0.2), passage_1: noul(0.88), passage_2: noul(0.61) },
    passages,
  );
  assert.equal(routed.verdict, "answered");
  assert.deepEqual(
    routed.spans.map((span) => span.index),
    [1, 2],
  );
});

test("a page that mentions the topic but does not answer it says so", () => {
  const routed = routeAnswer({ answered: noul(0.12), passage_0: noul(0.3), passage_1: noul(0.2) }, [
    "a",
    "b",
  ]);
  assert.equal(routed.verdict, "not_found");
  assert.deepEqual(routed.spans, []);
  const text = formatAnswer({ url: "https://x.test", question: "when?", ...routed });
  assert.match(text, /does not appear to answer: when\? \(answered 0\.12\)/);
});

test("a weak page still hands over its closest passages", () => {
  const routed = routeAnswer({ answered: noul(0.3), passage_0: noul(0.72) }, ["the answer"]);
  assert.equal(routed.verdict, "closest");
  const text = formatAnswer({ url: "https://x.test", question: "why?", ...routed });
  assert.match(text, /may not answer this directly/);
  assert.match(text, /\[passage 1 · 0\.72\]/);
  assert.match(text, /the answer/);
});

test("the count of returned passages is bounded", () => {
  const answers = { answered: noul(0.9) };
  for (let index = 0; index < 6; index += 1) answers["passage_" + index] = noul(0.9);
  const routed = routeAnswer(answers, ["a", "b", "c", "d", "e", "f"], { maxSpans: 2 });
  assert.equal(routed.spans.length, 2);
});
