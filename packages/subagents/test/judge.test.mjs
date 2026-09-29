import { test } from "node:test";
import assert from "node:assert/strict";
import {
  checkDiffScope,
  preflightQuestions,
  preflightTask,
  routePreflight,
  triageResult,
} from "../judge.mjs";

const noul = (value) => ({ type: "noul", noul: value });
const answering = (answers) => async () => ({ answers });

test("preflightQuestions only asks about decisions for write-capable agents", () => {
  assert.ok(!("needs_decision" in preflightQuestions({ writeCapable: false })));
  assert.ok("needs_decision" in preflightQuestions({ writeCapable: true }));
});

test("routePreflight rejects tasks that lean on invisible context", () => {
  const out = routePreflight({ self_contained: noul(0.05) });
  assert.match(out.reject, /context the child cannot see/);
});

test("routePreflight rejects open design decisions only for write-capable agents", () => {
  const answers = { self_contained: noul(0.9), needs_decision: noul(0.9) };
  assert.match(routePreflight(answers, { writeCapable: true }).reject, /design decision/);
  assert.equal(routePreflight(answers, { writeCapable: false }).reject, undefined);
});

test("routePreflight turns weak deliverable/scope into hints, not rejections", () => {
  const out = routePreflight({
    self_contained: noul(0.9),
    has_deliverable: noul(0.1),
    has_scope: noul(0.1),
  });
  assert.equal(out.reject, undefined);
  assert.equal(out.hints.length, 2);
});

test("routePreflight ignores missing or unusable answers", () => {
  assert.deepEqual(routePreflight(undefined), { reject: undefined, hints: [] });
  assert.deepEqual(routePreflight({ self_contained: noul(null) }), {
    reject: undefined,
    hints: [],
  });
});

test("preflightTask rejects once, then trusts an identical resubmission", async () => {
  const askImpl = answering({ self_contained: noul(0.01) });
  const args = { agent: "scout", task: "fix it as discussed", writeCapable: false, askImpl };
  assert.ok((await preflightTask(args)).reject);
  assert.equal((await preflightTask(args)).reject, undefined);
});

test("every judge fails open when TypeSafe errors", async () => {
  const askImpl = async () => {
    throw new Error("no key");
  };
  const out = await preflightTask({ agent: "a", task: "t-open", writeCapable: true, askImpl });
  assert.deepEqual(out, { reject: undefined, hints: [] });
  assert.equal(await triageResult({ agent: "a", task: "t", text: "r", askImpl }), undefined);
  assert.equal(await checkDiffScope({ task: "t", diff: "d", askImpl }), undefined);
});

test("triageResult formats the chosen outcome with its probability", async () => {
  const askImpl = answering({
    outcome: { type: "choice", choice: "partial", probabilities: { partial: 0.71 } },
  });
  assert.equal(await triageResult({ agent: "a", task: "t", text: "r", askImpl }), "partial (0.71)");
  assert.equal(await triageResult({ agent: "a", task: "t", text: "  ", askImpl }), undefined);
});

test("checkDiffScope warns only above the threshold and skips empty diffs", async () => {
  const high = answering({ out_of_scope: noul(0.9) });
  const low = answering({ out_of_scope: noul(0.1) });
  assert.match(await checkDiffScope({ task: "t", diff: "d", askImpl: high }), /beyond the task/);
  assert.equal(await checkDiffScope({ task: "t", diff: "d", askImpl: low }), undefined);
  assert.equal(await checkDiffScope({ task: "t", diff: "", askImpl: high }), undefined);
});
