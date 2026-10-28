// shadow-eval.mjs — shadow log line from the shared user-turn planner in route-turn.mjs.

import { offersExceptCooling } from "./usage-cap.mjs";
import {
  decisionReasonFromPlan,
  planUserRouteTurn,
  readBranchState,
  wouldBeTierFromPlan,
} from "./route-turn.mjs";
import { promptHash } from "./shadow-log.mjs";

function branchMessages(branch, prompt) {
  const list = (branch ?? []).map((entry) => entry?.message ?? entry).filter(Boolean);
  const trimmed = String(prompt ?? "").slice(0, 2000);
  const last = list[list.length - 1];
  const lastText =
    last?.content?.[0]?.text ?? last?.content?.find?.((c) => c.type === "text")?.text ?? "";
  if (trimmed && lastText.slice(0, 2000) !== trimmed) {
    list.push({ role: "user", content: [{ type: "text", text: trimmed }] });
  }
  return list;
}

/**
 * @returns {{ entry: object, nextState: object, judged: boolean }}
 */
export async function evaluateShadowTurn({
  prompt,
  branch,
  shadowState,
  actualKey,
  actualThinking,
  sessionId,
  selected,
  offers,
  tiers,
  ctx,
  cooling,
  threshold,
  frontierThreshold,
  timeoutMs,
  shareWindow,
  judge,
  prefetched,
  clock = () => Date.now(),
}) {
  const branchState = readBranchState(shadowState);
  const previousKey = branchState?.model ?? actualKey;
  const liveOffers = offersExceptCooling(offers, cooling);
  const messages = branchMessages(branch, prompt);
  const pref =
    prefetched && prefetched.prompt === String(prompt ?? "").slice(0, 2000)
      ? prefetched.answers
      : null;

  const planned = await planUserRouteTurn({
    messages,
    branchState,
    previousKey,
    offers,
    liveOffers,
    tiers,
    ctx,
    selected,
    cooling,
    threshold,
    frontierThreshold,
    timeoutMs,
    shareWindow,
    judge,
    prefetchedAnswers: pref,
  });

  const wouldTier = wouldBeTierFromPlan(planned.decided, planned.tier);
  return {
    judged: Boolean(planned.decided || planned.outcome === "judge-failed"),
    nextState: planned.state,
    entry: {
      at: clock(),
      sessionId,
      actual: { key: actualKey, thinking: actualThinking },
      wouldBe: {
        tier: wouldTier,
        key: planned.key ?? branchState?.model ?? actualKey,
        thinking: planned.thinking ?? actualThinking,
      },
      difficulty: planned.decided?.difficulty ?? null,
      gateReason: planned.boundary.reason,
      decisionReason: decisionReasonFromPlan(planned.decided, planned.outcome),
      promptHash: promptHash(String(prompt ?? "").slice(0, 2000)),
    },
  };
}
