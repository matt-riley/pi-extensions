// The recall exam's own logic: what it asks about, and how it reads the answers.
import assert from "node:assert/strict";
import test from "node:test";

import { validateRequest } from "../shared/systemone.mjs";
import {
  claimsFrom,
  constraintsFrom,
  examine,
  excerptOf,
  groundingQuestion,
  meaningfulLines,
  retentionQuestion,
  splitAtCompaction,
  summarise,
} from "./safe-compact-recall.mjs";

const message = (role, text) => ({ role, text });
const entry = (role, text) => ({ type: "message", message: { role, content: [{ text }] } });

test("meaningfulLines drops bullets' markers, short lines and duplicates", () => {
  const text = [
    "- First finding that is long enough to keep",
    "- First finding that is long enough to keep",
    "- short",
    "* Another bullet line that qualifies",
    "1. Numbered bullet that qualifies too",
    "",
    "no marker, still a line that qualifies",
  ].join("\n");
  assert.deepEqual(meaningfulLines(text, { minChars: 20 }), [
    "First finding that is long enough to keep",
    "Another bullet line that qualifies",
    "Numbered bullet that qualifies too",
    "no marker, still a line that qualifies",
  ]);
  // Over the cap it samples across the text, keeping the order.
  const many = Array.from(
    { length: 10 },
    (_, index) => "line " + index + " that is long enough to keep",
  );
  const sampled = meaningfulLines(many.join("\n"), { minChars: 20, max: 3 });
  assert.equal(sampled.length, 3);
  assert.match(sampled[0], /line 0/);
  assert.match(sampled[2], /line [6-9]/);
});

test("constraintsFrom takes instructions from the user, not from the agent", () => {
  const messages = [
    message("assistant", "I will look at the repo and report back with the findings shortly."),
    message(
      "user",
      "Please fix the loader and keep the diff small.\nNever add a dependency for this.",
    ),
    message("user", "- Always run the full check before pushing"),
    message("assistant", "Right, running the full check before pushing each time now."),
    message("user", "Now update the README as well, please, and keep it short."),
  ];
  assert.deepEqual(constraintsFrom(messages), [
    "Please fix the loader and keep the diff small.",
    "Never add a dependency for this.",
    "Always run the full check before pushing",
    "Now update the README as well, please, and keep it short.",
  ]);
  // Past the cap the most recent instructions are the ones still in force; the
  // opening request is not sampled, because by the cut it is usually finished.
  const many = Array.from({ length: 8 }, (_, index) =>
    message("user", "Instruction number " + index + " which is long enough"),
  );
  const capped = constraintsFrom(many, { max: 3 });
  assert.equal(capped.length, 3);
  assert.match(capped[0], /Instruction number 5/);
  assert.match(capped[2], /Instruction number 7/);
});

test("claimsFrom takes the handoff's bullets, all of them up to the cap", () => {
  const handoff = [
    "## Goal",
    "",
    "- first claim that is long enough to count as one",
    "prose paragraph that is not a bullet and is long enough",
    "- second claim that is long enough to count as one",
  ].join("\n");
  assert.deepEqual(claimsFrom(handoff), [
    "first claim that is long enough to count as one",
    "second claim that is long enough to count as one",
  ]);
});

test("summarise counts what is kept, missed and contradicted", () => {
  const summary = summarise({
    constraints: ["kept one", "dropped one", "unreadable one"],
    claims: ["supported one", "contradicted one", "outside one"],
    retention: [0.92, 0.11, null],
    grounding: ["supported", "contradicted", "not_in_excerpt"],
  });
  assert.deepEqual(summary.retention, {
    kept: 1,
    of: 2,
    unreadable: 1,
    mean: 0.515,
    dropped: 1,
  });
  assert.deepEqual(summary.missed, ["dropped one"]);
  assert.equal(summary.unreadable, 1);
  assert.deepEqual(summary.grounding, {
    supported: 1,
    contradicted: 1,
    not_in_excerpt: 1,
    of: 3,
    checkable: 2,
    contradictedClaims: ["contradicted one"],
  });
});

test("splitAtCompaction hands back the replaced messages and the handoff", () => {
  const entries = [
    entry("user", "first task"),
    entry("assistant", "first answer"),
    { type: "compaction", summary: "older handoff", details: { safeCompact: { segments: 2 } } },
    entry("user", "second task"),
    { type: "compaction", summary: "newer handoff", tokensBefore: 1234 },
  ];
  const newest = splitAtCompaction({ entries });
  assert.equal(newest.handoff, "newer handoff");
  assert.equal(newest.tokensBefore, 1234);
  assert.deepEqual(
    newest.replaced.map((item) => item.text),
    ["first task", "first answer", "second task"],
  );
  const older = splitAtCompaction({ entries }, 0);
  assert.equal(older.handoff, "older handoff");
  assert.deepEqual(
    older.replaced.map((item) => item.text),
    ["first task", "first answer"],
  );
  assert.equal(splitAtCompaction({ entries: [entry("user", "no compaction here")] }), null);
});

test("excerptOf samples the whole session, not just its opening", () => {
  const filler = "x".repeat(400);
  const replaced = Array.from({ length: 100 }, (_, index) =>
    message(index % 2 ? "assistant" : "user", "message " + index + " " + filler),
  );
  const excerpt = excerptOf(replaced, { budget: 4_000, perMessage: 500 });
  assert.ok(excerpt.length <= 4_000);
  assert.match(excerpt, /message 0/);
  // The claim that matters is usually from the end: a head-only sample would
  // answer not_in_excerpt for it, which is a sampling failure, not grounding.
  assert.match(excerpt, /message 99/);
  assert.equal(excerptOf([]), "");
});

test("examine reads Jev's answer shapes and refuses a handoff too big to send", async () => {
  const asked = [];
  const ask = async (request) => {
    validateRequest(request);
    asked.push(request);
    if ("conveyed" in request.questions) {
      return { answers: { conveyed: { type: "noul", noul: 0.7 } } };
    }
    return { answers: { supported: { type: "choice", choice: "supported", confidence: 0.9 } } };
  };
  const replaced = [
    message("user", "Please fix the loader and keep the diff small."),
    message("assistant", "The loader now retries twice."),
  ];
  const handoff = "- the loader now retries twice before it gives up";
  const result = await examine({ replaced, handoff, ask, max: 4 });
  assert.equal(result.retention.length, 1);
  assert.equal(result.summary.retention.kept, 1);
  assert.equal(result.summary.retention.mean, 0.7);
  assert.equal(result.summary.grounding.supported, 1);
  assert.equal(asked.length, 2);

  // An unreadable answer is counted as unreadable, not as a dropped constraint.
  const unreadable = await examine({
    replaced,
    handoff,
    ask: async (request) =>
      "conveyed" in request.questions
        ? { answers: { conveyed: { type: "noul", noul: null } } }
        : { answers: {} },
  });
  assert.equal(unreadable.summary.unreadable, 1);
  assert.equal(unreadable.summary.retention.of, 0);
  assert.deepEqual(unreadable.summary.missed, []);

  await assert.rejects(
    examine({ replaced, handoff: "x".repeat(60_001), ask }),
    /handoff is 60001 characters/,
  );
});

test("the exam's questions name state the exam actually sends", () => {
  validateRequest({ state: { handoff: "h", constraint: "c" }, questions: retentionQuestion() });
  validateRequest({ state: { excerpt: "e", claim: "c" }, questions: groundingQuestion() });
});
