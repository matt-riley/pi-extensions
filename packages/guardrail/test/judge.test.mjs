import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BLAST_LEVELS,
  buildJudgeState,
  buildQuestionSet,
  extractUserRequest,
  judgeToolCall,
  recommendedAction,
  routeVerdict,
} from "../judge.mjs";

const noul = (value) => ({ type: "noul", noul: value });
const score = (value) => ({ type: "score", score: value });

// ---------------------------------------------------------------------------
// The question set

test("the battery is four typed questions with thresholds in code", () => {
  const questions = buildQuestionSet();
  assert.deepEqual(Object.keys(questions).sort(), [
    "blast_radius",
    "credentials",
    "destructive",
    "intent_mismatch",
  ]);
  assert.equal(questions.destructive.type, "noul");
  assert.equal(questions.intent_mismatch.type, "noul");
  assert.equal(questions.credentials.type, "noul");
  assert.equal(questions.blast_radius.type, "score");
  assert.equal(questions.blast_radius.criteria.length, BLAST_LEVELS.length);
  // Each question must carry its whole meaning: ids never reach the model.
  assert.match(questions.destructive.instructions, /`action`/);
  assert.match(questions.intent_mismatch.instructions, /`user_request`/);
});

// ---------------------------------------------------------------------------
// State

test("buildJudgeState names its fields and truncates a runaway action", () => {
  const state = buildJudgeState({
    action: "x".repeat(5000),
    toolName: "bash",
    cwd: "/repo",
    userRequest: "clean up the build output",
    policyReason: "delete (rm) on workspace",
    targetClass: "workspace",
  });
  assert.equal(state.tool, "bash");
  assert.equal(state.action.length, 1500);
  assert.equal(state.user_request, "clean up the build output");
  assert.equal(state.target_class, "workspace");
  assert.equal(state.why_it_was_flagged, "delete (rm) on workspace");
  assert.equal(state.working_directory, "/repo");
});

test("extractUserRequest reads the last user turn from a branch", () => {
  const branch = [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "first ask" }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } },
    { type: "message", message: { role: "user", content: "second ask" } },
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "toolCall", name: "bash" }] },
    },
  ];
  assert.equal(extractUserRequest(branch), "second ask");
  assert.equal(
    extractUserRequest([
      { message: { role: "user", content: [{ type: "text", text: "  padded  " }] } },
    ]),
    "padded",
  );
  assert.equal(extractUserRequest([{ message: { role: "assistant", content: "hi" } }]), null);
  assert.equal(extractUserRequest(undefined), null);
  assert.equal(extractUserRequest([{ message: { role: "user", content: 42 } }]), null);
});

test("extractUserRequest truncates a giant request instead of shipping it whole", () => {
  const huge = "y".repeat(2000);
  assert.equal(extractUserRequest([{ message: { role: "user", content: huge } }]).length, 600);
});

// ---------------------------------------------------------------------------
// Routing: the thresholds are the product

test("quiet answers allow", () => {
  const routed = routeVerdict({
    destructive: noul(0.04),
    intent_mismatch: noul(0.1),
    blast_radius: score(1),
    credentials: noul(0.02),
  });
  assert.equal(routed.verdict, "allow");
  assert.match(routed.reason, /destroying irreplaceable data 0\.04/);
});

test("destructive but scoped asks the human", () => {
  assert.equal(
    routeVerdict({ destructive: noul(0.72), blast_radius: score(1) }).verdict,
    "confirm",
  );
  assert.equal(
    routeVerdict({ destructive: noul(0.3), intent_mismatch: noul(0.81), blast_radius: score(0) })
      .verdict,
    "confirm",
  );
  assert.equal(routeVerdict({ blast_radius: score(2) }).verdict, "confirm");
});

test("unrecoverable damage on a machine-wide or remote scale refuses", () => {
  const routed = routeVerdict({ destructive: noul(0.93), blast_radius: score(3) });
  assert.equal(routed.verdict, "block");
  assert.equal(routed.signals.blast_radius, 3);
});

test("credentials leaving the machine refuse, credentials alone ask", () => {
  assert.equal(routeVerdict({ credentials: noul(0.9), blast_radius: score(3) }).verdict, "block");
  assert.equal(routeVerdict({ credentials: noul(0.9), blast_radius: score(1) }).verdict, "confirm");
});

test("boundary values sit on the threshold, not past it", () => {
  assert.equal(routeVerdict({ destructive: noul(0.5), blast_radius: score(0) }).verdict, "confirm");
  assert.equal(routeVerdict({ destructive: noul(0.49), blast_radius: score(0) }).verdict, "allow");
  assert.equal(
    routeVerdict({ intent_mismatch: noul(0.59), blast_radius: score(0) }).verdict,
    "allow",
  );
});

test("unusable answers never silently approve", () => {
  const routed = routeVerdict({
    destructive: { type: "noul", noul: null },
    blast_radius: { type: "score" },
  });
  assert.equal(routed.verdict, null);
  assert.match(routed.reason, /no usable answers/);
});

// ---------------------------------------------------------------------------
// Recommendations: offered only when the judgment is clear

test("recommendedAction stays quiet when the answers disagree", () => {
  assert.equal(
    recommendedAction({
      destructive: 0.62,
      blast_radius: 2,
      credentials: 0.01,
      intent_mismatch: 0.3,
    }),
    null,
  );
  assert.equal(
    recommendedAction({
      destructive: 0.45,
      blast_radius: 1,
      credentials: 0.02,
      intent_mismatch: 0.5,
    }),
    null,
  );
  assert.equal(recommendedAction(null), null);
});

test("recommendedAction denies clear danger and approves clear safety", () => {
  assert.equal(recommendedAction({ destructive: 0.9, blast_radius: 3 }), "Deny");
  assert.equal(recommendedAction({ destructive: 0.1, credentials: 0.9, blast_radius: 0 }), "Deny");
  assert.equal(
    recommendedAction({
      destructive: 0.05,
      blast_radius: 1,
      credentials: 0.01,
      intent_mismatch: 0.1,
    }),
    "Approve",
  );
});

// ---------------------------------------------------------------------------
// Failure handling: a guardrail that crashes is worse than one that asks

test("judgeToolCall routes real answers through the thresholds", async () => {
  const result = await judgeToolCall({
    action: "rm -rf src",
    toolName: "bash",
    ask: async () => ({
      model: "jev-test",
      answers: {
        destructive: noul(0.62),
        intent_mismatch: noul(0.2),
        blast_radius: score(2),
        credentials: noul(0.01),
      },
    }),
  });
  assert.equal(result.verdict, "confirm");
  assert.equal(result.judged, true);
  assert.equal(result.model, "jev-test");
});

test("judgeToolCall falls back rather than throwing when the judge is missing", async () => {
  const result = await judgeToolCall({
    action: "rm -rf src",
    ask: async () => {
      throw new Error("TYPESAFE_API_KEY is not set");
    },
  });
  assert.equal(result.verdict, "confirm");
  assert.equal(result.judged, false);
  assert.match(result.reason, /judge unavailable: TYPESAFE_API_KEY is not set/);
});

test("the fallback is the caller's policy decision, not a hidden default", async () => {
  const result = await judgeToolCall({
    action: "rm -rf src",
    fallbackVerdict: "block",
    ask: async () => {
      throw new Error("timed out");
    },
  });
  assert.equal(result.verdict, "block");
});

test("a judge that returns nothing usable falls back too", async () => {
  const result = await judgeToolCall({ action: "x", ask: async () => ({ answers: {} }) });
  assert.equal(result.verdict, "confirm");
  assert.equal(result.judged, false);
});

test("the deadline is passed to the transport as an abort signal", async () => {
  let seen;
  await judgeToolCall({
    action: "x",
    timeoutMs: 25,
    ask: async ({ signal }) => {
      seen = signal;
      return { answers: { destructive: noul(0) } };
    },
  });
  assert.ok(seen instanceof AbortSignal);
});
