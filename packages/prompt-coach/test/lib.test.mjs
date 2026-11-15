import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CONCISE_STYLE,
  extractLastUserPrompt,
  parseImproveArgs,
  stripConciseStyle,
  usableNoul,
  validateCandidate,
  withConciseStyle,
} from "../lib.mjs";

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

test("parseImproveArgs reads a leading --concise flag and leaves the rest alone", () => {
  assert.deepEqual(parseImproveArgs("--concise fix the build"), {
    concise: true,
    prompt: "fix the build",
  });
  assert.deepEqual(parseImproveArgs("  --concise  "), { concise: true, prompt: "" });
  assert.deepEqual(parseImproveArgs("fix the build"), { concise: false, prompt: "fix the build" });
});

test("parseImproveArgs does not mistake a longer word or a later mention for the flag", () => {
  assert.deepEqual(parseImproveArgs("--concise-mode docs"), {
    concise: false,
    prompt: "--concise-mode docs",
  });
  assert.deepEqual(parseImproveArgs("write a --concise reply"), {
    concise: false,
    prompt: "write a --concise reply",
  });
  assert.deepEqual(parseImproveArgs(undefined), { concise: false, prompt: "" });
});

test("the concise style keeps its requirements", () => {
  assert.match(CONCISE_STYLE, /\bresult\b/i);
  assert.match(CONCISE_STYLE, /no preamble/i);
  assert.match(CONCISE_STYLE, /destructive/i);
  assert.match(CONCISE_STYLE, /failing test output/i);
  assert.match(CONCISE_STYLE, /\berror/i);
  assert.match(CONCISE_STYLE, /security warning/i);
  assert.match(CONCISE_STYLE, /in full/i);
  assert.match(CONCISE_STYLE, /^Answer style \(concise\):/);
});

test("stripConciseStyle removes the style paragraph, however it was edited", () => {
  const edited = "Fix the build.\n\nAnswer style (concise): reply in one line.\n";
  assert.equal(stripConciseStyle(edited), "Fix the build.");
  assert.equal(stripConciseStyle(`Fix the build.\n\n${CONCISE_STYLE}`), "Fix the build.");
  assert.equal(stripConciseStyle("Fix the build."), "Fix the build.");
  assert.equal(stripConciseStyle(CONCISE_STYLE), "");
});

test("an answer-style sentence in the middle of a prompt is left alone", () => {
  const text = "Explain the Answer style (concise): option in the docs.\n\nThen fix it.";
  assert.equal(stripConciseStyle(text), text);
});

test("withConciseStyle leaves exactly one style paragraph, even over an edited one", () => {
  const edited = "Fix the build.\n\nAnswer style (concise): reply in one line.";
  const result = withConciseStyle(edited);
  assert.equal(result, `Fix the build.\n\n${CONCISE_STYLE}`);
  assert.equal(result.split("Answer style (concise):").length - 1, 1);
});

test("withConciseStyle adds the style once, after the prompt", () => {
  const once = withConciseStyle("Fix the build.");
  assert.equal(once, `Fix the build.\n\n${CONCISE_STYLE}`);
  assert.equal(withConciseStyle(once), once);
});
