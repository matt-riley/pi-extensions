import { test } from "node:test";
import assert from "node:assert/strict";

import { findSlop } from "../patterns.mjs";
import {
  THRESHOLDS,
  buildFindingsQuestions,
  buildFindingsState,
  buildRewriteQuestions,
  buildRewriteState,
  routeFindings,
  routeRewrite,
  verifyFindings,
  verifyRewrite,
} from "../verify.mjs";

const noul = (value) => ({ type: "noul", noul: value });
const SLOP = "It's worth noting that this is a seamless upgrade.";

test("both batteries are typed questions that name the state fields they read", () => {
  const findings = buildFindingsQuestions();
  assert.deepEqual(Object.keys(findings).sort(), ["discusses_patterns", "worse_for_reader"]);
  const rewrite = buildRewriteQuestions();
  assert.deepEqual(Object.keys(rewrite).sort(), ["meaning_preserved", "still_formulaic"]);
  for (const question of [...Object.values(findings), ...Object.values(rewrite)]) {
    assert.equal(question.type, "noul");
    assert.equal(typeof question.criteria.true, "string");
    assert.equal(typeof question.criteria.false, "string");
  }
  for (const question of Object.values(findings)) {
    assert.match(question.instructions, /`text`/);
    assert.match(question.instructions, /`findings`/);
  }
  assert.match(rewrite.meaning_preserved.instructions, /`before`/);
  assert.match(rewrite.meaning_preserved.instructions, /`after`/);
  assert.match(rewrite.still_formulaic.instructions, /`after`/);
});

test("the state is named fields, clipped, with findings reduced to what Jev needs", () => {
  const state = buildFindingsState({
    path: "README.md",
    text: "word ".repeat(4000),
    findings: findSlop(SLOP),
  });
  assert.equal(state.path, "README.md");
  assert.equal(state.text.length, 6000);
  assert.deepEqual(Object.keys(state.findings[0]).sort(), ["excerpts", "pattern", "severity"]);
  const rewrite = buildRewriteState({ path: "a.md", before: "word ".repeat(1800), after: "z" });
  assert.equal(rewrite.before.length, 6000);
  assert.equal(rewrite.after, "z");
});

test("the thresholds cannot be re-tuned at runtime", () => {
  assert.equal(Object.isFrozen(THRESHOLDS), true);
});

test("findings are confirmed only when the patterns make the text worse", () => {
  assert.equal(routeFindings({ worse_for_reader: noul(0.9) }).verdict, "confirmed");
  assert.equal(routeFindings({ worse_for_reader: noul(0.2) }).verdict, "dismissed");
  assert.equal(routeFindings({ worse_for_reader: noul(0.5) }).verdict, "confirmed");
});

test("text that catalogues the patterns is dismissed however bad it scores", () => {
  const routed = routeFindings({ worse_for_reader: noul(0.95), discusses_patterns: noul(0.8) });
  assert.equal(routed.verdict, "dismissed");
  assert.match(routed.reason, /worse_for_reader 0\.95 · discusses_patterns 0\.80/);
});

test("no usable worse_for_reader answer is no verdict", () => {
  assert.equal(routeFindings({}).verdict, null);
  assert.equal(routeFindings({ worse_for_reader: { type: "noul", noul: "" } }).verdict, null);
  assert.equal(routeFindings({ discusses_patterns: noul(0.1) }).verdict, null);
});

test("a rewrite that changes the meaning outranks every other verdict", () => {
  const routed = routeRewrite(
    { meaning_preserved: noul(0.2), still_formulaic: noul(0.1) },
    { remainingReportable: false },
  );
  assert.equal(routed.verdict, "meaning_changed");
  assert.equal(routed.judged, true);
});

test("a rewrite is still slop when the detector or Jev says so", () => {
  const kept = { meaning_preserved: noul(0.9) };
  assert.equal(routeRewrite(kept, { remainingReportable: true }).verdict, "still_slop");
  assert.equal(
    routeRewrite({ ...kept, still_formulaic: noul(0.8) }, { remainingReportable: false }).verdict,
    "still_slop",
  );
  assert.equal(
    routeRewrite({ ...kept, still_formulaic: noul(0.3) }, { remainingReportable: false }).verdict,
    "clean",
  );
});

test("verifyFindings sends one batched request and routes its answers", async () => {
  const calls = [];
  const judged = await verifyFindings({
    path: "README.md",
    text: SLOP,
    findings: findSlop(SLOP),
    ask: async (request) => {
      calls.push(request);
      return { answers: { worse_for_reader: noul(0.84), discusses_patterns: noul(0.05) } };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].feature, "deslop");
  assert.equal(calls[0].state.text, SLOP);
  assert.deepEqual(Object.keys(calls[0].questions).sort(), [
    "discusses_patterns",
    "worse_for_reader",
  ]);
  assert.ok(calls[0].signal instanceof AbortSignal);
  assert.equal(judged.judged, true);
  assert.equal(judged.verdict, "confirmed");
  assert.equal(judged.signals.worse_for_reader, 0.84);
});

test("verifyFindings never throws: a failed judge is unjudged", async () => {
  const judged = await verifyFindings({
    text: SLOP,
    findings: findSlop(SLOP),
    ask: async () => {
      throw new Error("TYPESAFE_API_KEY is not set");
    },
  });
  assert.equal(judged.judged, false);
  assert.equal(judged.verdict, null);
  assert.match(judged.reason, /judge unavailable: TYPESAFE_API_KEY is not set/);

  const empty = await verifyFindings({ text: SLOP, findings: [], ask: async () => ({}) });
  assert.equal(empty.judged, false);
});

test("verifyRewrite compares before with after and reports a changed meaning", async () => {
  const calls = [];
  const judged = await verifyRewrite({
    path: "README.md",
    before: "The cache holds 100 entries and is cleared on restart.",
    after: "The cache is fast.",
    ask: async (request) => {
      calls.push(request);
      return { answers: { meaning_preserved: noul(0.12), still_formulaic: noul(0.2) } };
    },
  });
  assert.equal(calls[0].state.before, "The cache holds 100 entries and is cleared on restart.");
  assert.equal(calls[0].state.after, "The cache is fast.");
  assert.equal(judged.verdict, "meaning_changed");
});

test("with the judge down, verifyRewrite falls back to the deterministic recheck", async () => {
  const down = async () => {
    throw new Error("timeout");
  };
  const still = await verifyRewrite({
    before: "a",
    after: "b",
    remainingReportable: true,
    ask: down,
  });
  assert.equal(still.verdict, "still_slop");
  assert.equal(still.judged, false);
  assert.match(still.reason, /judge unavailable: timeout/);
  const clean = await verifyRewrite({ before: "a", after: "b", ask: down });
  assert.equal(clean.verdict, "clean");
});
