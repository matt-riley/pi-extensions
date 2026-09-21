import { test } from "node:test";
import assert from "node:assert/strict";

import { extractLastUserPrompt, usableNoul, validateCandidate } from "../lib.mjs";

const noul = (value) => ({ type: "noul", noul: value });

test("extractLastUserPrompt returns the latest textual user message", () => {
  assert.equal(
    extractLastUserPrompt([
      { message: { role: "user", content: "first" } },
      { message: { role: "assistant", content: "answer" } },
      { message: { role: "user", content: [{ type: "text", text: "latest" }] } },
    ]),
    "latest",
  );
});

test("extractLastUserPrompt ignores empty and non-user entries", () => {
  assert.equal(
    extractLastUserPrompt([
      { message: { role: "user", content: "" } },
      { message: { role: "assistant", content: "answer" } },
    ]),
    "",
  );
});

test("validateCandidate accepts a changed bounded prompt", () => {
  assert.deepEqual(validateCandidate("fix it", "Fix the failing test and run npm test."), {
    ok: true,
    text: "Fix the failing test and run npm test.",
    changed: true,
  });
});

test("validateCandidate accepts unchanged output but rejects unusable output", () => {
  assert.equal(validateCandidate("fix it", "fix it").changed, false);
  assert.equal(validateCandidate("fix it", "").ok, false);
  assert.equal(validateCandidate("fix it", "x".repeat(20), { maxLength: 10 }).ok, false);
  assert.equal(validateCandidate("fix it", "bad\u0000prompt").ok, false);
});

test("usableNoul clamps valid values and rejects other answers", () => {
  assert.equal(usableNoul(noul(0.75)), 0.75);
  assert.equal(usableNoul(noul(2)), 1);
  assert.equal(usableNoul(noul(-1)), 0);
  assert.equal(usableNoul({ type: "score", score: 2 }), null);
});
