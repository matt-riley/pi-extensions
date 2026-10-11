import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_TIMEOUT_MS,
  buildClaimQuestionSet,
  buildClaimState,
  claimLine,
  judgeDoneClaim,
  routeClaim,
} from "../claim.mjs";

const noul = (value) => ({ type: "noul", noul: value });

// ---------------------------------------------------------------------------
// The question set

test("the claim battery is two typed questions that name their state fields", () => {
  const questions = buildClaimQuestionSet();
  assert.deepEqual(Object.keys(questions).sort(), ["acknowledges_gap", "asserts_verified"]);
  for (const question of Object.values(questions)) {
    assert.equal(question.type, "noul");
    assert.match(question.instructions, /`claim`/);
    assert.equal(typeof question.criteria.true, "string");
    assert.equal(typeof question.criteria.false, "string");
  }
  assert.match(questions.asserts_verified.instructions, /`verification_seen`/);
});

test("buildClaimState names fields, truncates the claim and keeps the run facts", () => {
  const state = buildClaimState({
    claim: "x".repeat(5000),
    files: ["src/a.ts", "src/b.ts"],
    verificationSeen: false,
  });
  assert.equal(state.claim.length, 1500);
  assert.deepEqual(state.changed_files, ["src/a.ts", "src/b.ts"]);
  assert.equal(state.verification_seen, false);
});

// ---------------------------------------------------------------------------
// Routing: the thresholds are the product

test("a claim that asserts success without the gap is unclosed", () => {
  const routed = routeClaim({ asserts_verified: noul(0.88), acknowledges_gap: noul(0.05) });
  assert.equal(routed.verdict, "unclosed");
  assert.match(routed.reason, /asserts_verified 0\.88/);
  assert.match(routed.reason, /acknowledges_gap 0\.05/);
});

test("a claim that names the gap is acknowledged, even when it also says done", () => {
  const routed = routeClaim({ asserts_verified: noul(0.55), acknowledges_gap: noul(0.9) });
  assert.equal(routed.verdict, "acknowledged");
});

test("a neutral claim routes nowhere instead of guessing", () => {
  assert.equal(
    routeClaim({ asserts_verified: noul(0.4), acknowledges_gap: noul(0.4) }).verdict,
    null,
  );
  const empty = routeClaim({});
  assert.equal(empty.verdict, null);
  assert.match(empty.reason, /no usable answers/);
  assert.equal(routeClaim({ asserts_verified: noul(null) }).verdict, null);
  assert.equal(
    routeClaim({ asserts_verified: { type: "choice", choice: "yes" } }).verdict,
    null,
    "an answer of the wrong type is not a judgment",
  );
});

// ---------------------------------------------------------------------------
// The line that reaches the model

test("only an unclosed claim adds a line, and it carries the numbers", () => {
  const line = claimLine({
    judged: true,
    verdict: "unclosed",
    signals: { asserts_verified: 0.88, acknowledges_gap: 0.05 },
  });
  assert.match(line, /TypeSafe/);
  assert.match(line, /asserts_verified 0\.88/);
  assert.match(line, /acknowledges_gap 0\.05/);
  assert.match(line, /unverified/i);
  assert.equal(claimLine({ judged: true, verdict: "acknowledged", signals: {} }), null);
  assert.equal(claimLine({ judged: false, verdict: null, signals: {} }), null);
  assert.equal(claimLine(undefined), null);
});

test("a one-sided answer still renders only the numbers that exist", () => {
  const line = claimLine({
    judged: true,
    verdict: "unclosed",
    signals: { asserts_verified: null, acknowledges_gap: 0.02 },
  });
  assert.doesNotMatch(line, /asserts_verified/);
  assert.match(line, /acknowledges_gap 0\.02/);
});

// ---------------------------------------------------------------------------
// The call

test("judgeDoneClaim sends the state, routes the answers and reports the model", async () => {
  const calls = [];
  const ask = async (request) => {
    calls.push(request);
    return {
      model: "jev-latest",
      answers: { asserts_verified: noul(0.9), acknowledges_gap: noul(0.02) },
      usage: { total_tokens: 12 },
    };
  };
  const judged = await judgeDoneClaim({
    claim: "All green, done.",
    files: ["src/a.ts"],
    verificationSeen: true,
    ask,
  });

  assert.equal(judged.judged, true);
  assert.equal(judged.verdict, "unclosed");
  assert.equal(judged.model, "jev-latest");
  assert.deepEqual(judged.usage, { total_tokens: 12 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].state.claim, "All green, done.");
  assert.equal(calls[0].state.verification_seen, true);
  assert.deepEqual(Object.keys(calls[0].questions).sort(), [
    "acknowledges_gap",
    "asserts_verified",
  ]);
  assert.ok(calls[0].signal instanceof AbortSignal, "the call always carries a timeout signal");
});

test("a provider failure returns unjudged instead of throwing into the settle path", async () => {
  const ask = async () => {
    throw new Error("TypeSafe request failed with status 500");
  };
  const judged = await judgeDoneClaim({ claim: "done", files: ["src/a.ts"], ask });
  assert.equal(judged.judged, false);
  assert.equal(judged.verdict, null);
  assert.match(judged.reason, /judge unavailable: TypeSafe request failed with status 500/);
  assert.equal(claimLine(judged), null);
});

test("no claim text means no request at all", async () => {
  let called = false;
  const ask = async () => {
    called = true;
    return { answers: {} };
  };
  for (const claim of [undefined, "", "   "]) {
    const judged = await judgeDoneClaim({ claim, files: ["src/a.ts"], ask });
    assert.equal(judged.judged, false);
    assert.equal(judged.verdict, null);
    assert.match(judged.reason, /no claim to judge/);
  }
  assert.equal(called, false, "a missing claim must not cost a request");
});

test("unusable answers are unjudged, not a verdict", async () => {
  const ask = async () => ({ answers: { asserts_verified: { type: "noul", noul: "  " } } });
  const judged = await judgeDoneClaim({ claim: "done", files: [], ask });
  assert.equal(judged.judged, false);
  assert.equal(judged.verdict, null);
  assert.match(judged.reason, /judge unavailable/);
});

test("the default timeout is short because this sits in the settle path", () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 4000);
});
