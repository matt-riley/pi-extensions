// route-turn.mjs — shared user-turn routing: gate, judgement budget, decideRoute, cooling failover.
//
// Used by index.ts route() and shadow logging so production and shadow cannot drift.

import { decideRoute, fitting, unwrap } from "./decide.mjs";
import { gateTurn } from "./lib.mjs";
import { forcedTierDecision } from "./tier-override.mjs";
import {
  buildDifficultyState,
  buildDifficultyQuestions,
  chooseModelForTier,
  latestContextTokens,
  modelKey,
  routeFromDifficulty,
  turnsFromMessages,
  WINDOW,
} from "./model-battery.mjs";

export const BASE_TIER = "base";
const MAX_JUDGEMENTS_PER_TASK = 3;
const STUCK_FAILURES = 2;
const FAILURE_COOLDOWN_TURNS = 3;

/** Resolve a "provider/id" against the candidate list, then the registry. */
export function resolveKey(offers, ctx, key) {
  if (!key) return null;
  const match = offers.find((entry) => modelKey(entry) === key);
  if (match) return unwrap(match);
  const slash = key.indexOf("/");
  if (slash <= 0) return null;
  try {
    return (
      ctx?.modelRegistry?.find?.(key.slice(0, slash), key.slice(slash + 1)) ??
      ctx?.modelRegistry?.getModel?.(key.slice(0, slash), key.slice(slash + 1)) ??
      null
    );
  } catch {
    return null;
  }
}

export function pickBase(offers, ctx, previousKey, tiers, thinkingCap, baseTier = BASE_TIER) {
  const configured = chooseModelForTier(offers, baseTier, tiers, undefined, thinkingCap);
  if (configured) {
    return {
      model: configured.model,
      key: String(configured.key),
      thinking: configured.thinking,
    };
  }
  if (previousKey) {
    const model = resolveKey(offers, ctx, previousKey);
    if (model) return { model, key: previousKey, thinking: null };
  }
  const first = offers[0];
  if (!first) return null;
  return { model: unwrap(first), key: modelKey(first), thinking: null };
}

export function readBranchState(value) {
  if (!value || typeof value !== "object") return null;
  const raw = value;
  const tier = raw.tier;
  if (
    typeof raw.task !== "number" ||
    typeof raw.attempts !== "number" ||
    typeof raw.cooldown !== "number" ||
    (tier !== "base" && tier !== "mid" && tier !== "frontier")
  ) {
    return null;
  }
  const forcedTier = raw.forcedTier;
  return {
    task: raw.task,
    attempts: raw.attempts,
    cooldown: raw.cooldown,
    tier,
    model: typeof raw.model === "string" ? raw.model : null,
    thinking: typeof raw.thinking === "string" ? raw.thinking : null,
    base: typeof raw.base === "string" ? raw.base : null,
    forcedTier:
      forcedTier === "base" || forcedTier === "mid" || forcedTier === "frontier"
        ? forcedTier
        : null,
  };
}

/** Same rule as route(): when a difficulty judgement may run on a user turn. */
export function judgeableTurn({ prompt, boundary, failuresLastTurn, attempts, cooldown }) {
  const worthJudging = boundary.route || failuresLastTurn >= STUCK_FAILURES || attempts === 0;
  const judgeable =
    Boolean(prompt) && worthJudging && attempts < MAX_JUDGEMENTS_PER_TASK && cooldown === 0;
  return { worthJudging, judgeable };
}

function parseMessages(messages) {
  const turns = turnsFromMessages(messages, WINDOW + 1);
  const tail = turns[turns.length - 1];
  const includesCurrent = Boolean(tail && !tail.lastResponse && !tail.toolCalls.length);
  const history = (includesCurrent ? turns.slice(0, -1) : turns).slice(-WINDOW);
  const previousTurn = history[history.length - 1] ?? null;
  const prompt = String(tail?.prompt ?? "").slice(0, 2000);
  const boundary = gateTurn({ prompt, previousTurn });
  const failuresLastTurn = (previousTurn?.toolCalls ?? []).filter((call) => call.isError).length;
  const contextTokens = latestContextTokens(history);
  return { prompt, history, boundary, failuresLastTurn, contextTokens };
}

function applyCoolingFailover(next, decided, liveOffers, tiers, contextTokens, selected, cooling) {
  if (!next.key || !cooling.includes(next.key)) return next;
  const tier = decided?.tier ?? next.tier ?? BASE_TIER;
  const pick = chooseModelForTier(
    fitting(liveOffers, contextTokens),
    tier,
    tiers,
    undefined,
    selected,
  );
  if (pick && pick.key !== next.key) {
    return {
      outcome: "failover",
      model: pick.model,
      key: pick.key,
      thinking: pick.thinking ?? next.thinking ?? selected,
      tier,
      warning: null,
    };
  }
  return { ...next, warning: next.warning === "too-big" ? "too-big" : "cooling" };
}

/**
 * Plan a user-turn route the same way index.ts route() does after continuations are handled.
 */
export async function planUserRouteTurn({
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
  prefetchedAnswers = null,
  shouldAbortAfterJudge = () => false,
  forcedTier: forcedTierOverride = null,
}) {
  const branch = readBranchState(branchState);
  const base =
    pickBase(liveOffers, ctx, previousKey, tiers, selected) ??
    pickBase(offers, ctx, previousKey, tiers, selected);

  const heldKey = branch?.model ?? previousKey ?? base?.key ?? null;
  const heldModel = resolveKey(offers, ctx, heldKey) ?? base?.model ?? null;
  const heldThinking = branch?.thinking ?? base?.thinking ?? selected;

  const { prompt, history, boundary, failuresLastTurn, contextTokens } = parseMessages(messages);

  const cooldown = Math.max(0, (branch?.cooldown ?? 0) - 1);
  const task = boundary.route ? (branch?.task ?? 0) + 1 : (branch?.task ?? 1);
  const attempts = boundary.route ? 0 : (branch?.attempts ?? 0);

  const currentKey = heldKey ?? base?.key ?? null;
  const currentModel = resolveKey(offers, ctx, currentKey) ?? heldModel;

  let activeForced = branch?.forcedTier ?? null;
  if (boundary.route && !forcedTierOverride) activeForced = null;
  if (forcedTierOverride) activeForced = forcedTierOverride;

  const { judgeable } = judgeableTurn({
    prompt,
    boundary,
    failuresLastTurn,
    attempts,
    cooldown,
  });

  const held = {
    key: currentKey,
    thinking: heldThinking,
    tier: branch?.tier ?? BASE_TIER,
    model: currentModel,
  };
  let nextAttempts = attempts + (judgeable ? 1 : 0);
  let decided = null;

  let judged = false;

  if (activeForced) {
    decided = forcedTierDecision(activeForced);
  } else if (judgeable) {
    try {
      const result = prefetchedAnswers
        ? { answers: prefetchedAnswers }
        : await judge({
            state: buildDifficultyState({
              prompt,
              window: shareWindow ? history : [],
              cwd: ctx?.cwd,
            }),
            questions: buildDifficultyQuestions(),
            signal: AbortSignal.timeout(timeoutMs),
          });
      decided = routeFromDifficulty(result?.answers, { threshold, frontierThreshold });
      judged = true;
      if (shouldAbortAfterJudge()) {
        return {
          aborted: true,
          model: currentModel,
          thinking: held.thinking ?? selected,
          tier: held.tier,
          state: branch,
          decided: null,
          boundary,
          outcome: "aborted",
          contextTokens,
          warning: null,
          judged: true,
        };
      }
    } catch (error) {
      nextAttempts = attempts + 1;
      const failed = {
        task,
        attempts: nextAttempts,
        cooldown: FAILURE_COOLDOWN_TURNS,
        tier: held.tier,
        model: held.key,
        thinking: held.thinking,
        base: base?.key ?? branch?.base ?? null,
      };
      return {
        model: currentModel,
        key: held.key,
        thinking: held.thinking ?? selected,
        tier: held.tier,
        state: failed,
        decided: null,
        boundary,
        outcome: "judge-failed",
        contextTokens,
        warning: null,
        judged: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  let next = decideRoute({
    decided,
    offers: liveOffers,
    tiers,
    contextTokens,
    held,
    base,
    selected,
    boundary: boundary.route,
  });
  next = applyCoolingFailover(next, decided, liveOffers, tiers, contextTokens, selected, cooling);

  const nextState = {
    task,
    attempts: nextAttempts,
    cooldown,
    tier: next.tier ?? held.tier,
    model: next.key,
    thinking: next.thinking,
    base: base?.key ?? branch?.base ?? null,
    forcedTier: activeForced,
  };

  return {
    model: next.model,
    key: next.key,
    thinking: next.thinking ?? selected,
    tier: nextState.tier,
    state: nextState,
    decided,
    boundary,
    outcome: next.outcome,
    contextTokens,
    warning: next.warning ?? null,
    judged,
    aborted: false,
  };
}

export function wouldBeTierFromPlan(decided, nextTier) {
  if (decided?.escalate === true) return decided.tier;
  if (decided && decided.escalate === false) return BASE_TIER;
  return nextTier;
}

export function decisionReasonFromPlan(decided, outcome) {
  if (!decided) return "no judgement";
  if (outcome === "forced" || decided.forced) return "forced";
  if (decided.escalate === null) return outcome ?? "no-rating";
  return outcome ?? decided.reason ?? "held";
}
