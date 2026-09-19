// model-tier.mjs — the deterministic half of model choice.
//
// Two jobs, both measured elsewhere:
//
//   tierFor       prices this environment's models from real spend, so a tier
//                 means a number of dollars per million context tokens rather
//                 than a vendor's adjective.
//   chooseTier    the rules-based chooser, kept as the baseline that the judged
//                 version has to beat. On the corpus it either escalates a
//                 quarter of all turns (+848% spend) or downgrades exactly the
//                 turns that carried the most frustrated, hard-won context —
//                 see scripts/model-report.mjs.
//
// The chooser may only read what a router can see *before* a turn runs: the
// prompt, and what the previous turn already did. This turn's hop count,
// failures or tool use are the answer, not the question.

import { contentWords, groundTruth } from "./lib.mjs";

/** Effective price per million context tokens, from measured spend. */
const FRONTIER_AT = 0.25;
const MID_AT = 0.01;

/** Prompt markers that suggest a task is worth a stronger model. */
const COMPLEXITY_MARKERS = [
  "design",
  "architect",
  "refactor",
  "migrat",
  "tradeoff",
  "trade-off",
  "why ",
  "root cause",
  "security",
  "threat",
  "plan",
  "review",
  "debug",
  "investigat",
  "audit",
  "strategy",
  "protocol",
  "race condition",
  "deadlock",
  "concurren",
  "performance",
  "optimi",
  "benchmark",
  "compatib",
  "spec",
  "interface",
];

export function tierFor(pricePerMillion) {
  if (pricePerMillion >= FRONTIER_AT) return "frontier";
  if (pricePerMillion >= MID_AT) return "mid";
  return "economy";
}

/** Features a router can see before the turn runs. */
export function featureVector(turn, previousTurn) {
  const truth = groundTruth(turn);
  const text = String(turn.prompt ?? "");
  const lower = text.toLowerCase();
  return {
    promptChars: text.trim().length,
    promptWords: contentWords(text).size,
    hops: truth.toolCount,
    groups: truth.groups.size,
    failures: truth.failedCalls,
    conversational: truth.isConversational,
    hasEdit: truth.usedEdit,
    hasWeb: truth.usedWeb,
    marker: COMPLEXITY_MARKERS.some((marker) => lower.includes(marker)),
    previousHops: previousTurn?.features?.hops ?? 0,
    previousFailures: previousTurn?.features?.failures ?? 0,
    previousConversational: previousTurn?.features?.conversational ?? false,
  };
}

export function chooseTier(features, routerPreviousTier = null) {
  const reasons = [];
  if (features.promptChars >= 600) reasons.push("long prompt");
  if (features.marker && features.promptChars >= 80) reasons.push("complexity marker");
  if (routerPreviousTier === "frontier") reasons.push("continuing a task the router escalated");
  if (features.previousFailures >= 2) reasons.push("previous turn was failing");
  if (reasons.length) return { tier: "frontier", reasons };

  if (features.promptChars >= 120 || features.promptWords >= 12) {
    return { tier: "mid", reasons: ["a real task, not a one-liner"] };
  }
  return { tier: "economy", reasons: ["short and self-contained"] };
}
