// shadow-eval.mjs — run the same gate, judgement and decideRoute path as route(),
// without returning a model switch. Shadow state is separate from session routing.

import { decideRoute, fitting, unwrap } from "./decide.mjs";
import { gateTurn } from "./lib.mjs";
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
import { offersExceptCooling } from "./usage-cap.mjs";
import { promptHash } from "./shadow-log.mjs";

const BASE_TIER = "base";
const MAX_JUDGEMENTS_PER_TASK = 3;
const STUCK_FAILURES = 2;
const FAILURE_COOLDOWN_TURNS = 3;

function resolveKey(offers, ctx, key) {
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

function pickBase(offers, ctx, previousKey, tiers, thinkingCap) {
  const configured = chooseModelForTier(offers, BASE_TIER, tiers, undefined, thinkingCap);
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

function readShadowState(value) {
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
  return {
    task: raw.task,
    attempts: raw.attempts,
    cooldown: raw.cooldown,
    tier,
    model: typeof raw.model === "string" ? raw.model : null,
    thinking: typeof raw.thinking === "string" ? raw.thinking : null,
    base: typeof raw.base === "string" ? raw.base : null,
  };
}

function decisionReason(decided, next) {
  if (!decided) return "no judgement";
  if (decided.escalate === null) return next.outcome ?? "no-rating";
  return next.outcome ?? decided.reason ?? "held";
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
  const liveOffers = offersExceptCooling(offers, cooling);
  const previousKey = actualKey;
  const base =
    pickBase(liveOffers, ctx, previousKey, tiers, selected) ??
    pickBase(offers, ctx, previousKey, tiers, selected);

  const branchState = readShadowState(shadowState);
  const heldKey = branchState?.model ?? previousKey ?? base?.key ?? null;
  const heldModel = resolveKey(offers, ctx, heldKey) ?? base?.model ?? null;
  const heldThinking = branchState?.thinking ?? base?.thinking ?? selected;

  const turns = turnsFromMessages(branch, WINDOW + 1);
  const tail = turns[turns.length - 1];
  const includesCurrent = Boolean(tail && !tail.lastResponse && !tail.toolCalls.length);
  const history = (includesCurrent ? turns.slice(0, -1) : turns).slice(-WINDOW);
  const previousTurn = history[history.length - 1] ?? null;
  const trimmedPrompt = String(prompt ?? "").slice(0, 2000);
  const boundary = gateTurn({ prompt: trimmedPrompt, previousTurn });
  const failuresLastTurn = (previousTurn?.toolCalls ?? []).filter((call) => call.isError).length;

  const cooldown = Math.max(0, (branchState?.cooldown ?? 0) - 1);
  const task = boundary.route ? (branchState?.task ?? 0) + 1 : (branchState?.task ?? 1);
  const attempts = boundary.route ? 0 : (branchState?.attempts ?? 0);

  const contextTokens = latestContextTokens(history);
  const currentKey = heldKey ?? base?.key ?? null;
  const currentModel = resolveKey(offers, ctx, currentKey) ?? heldModel;

  const worthJudging = boundary.route || failuresLastTurn >= STUCK_FAILURES || attempts === 0;
  const judgeable =
    Boolean(trimmedPrompt) && worthJudging && attempts < MAX_JUDGEMENTS_PER_TASK && cooldown === 0;

  const held = {
    key: currentKey,
    thinking: heldThinking,
    tier: branchState?.tier ?? BASE_TIER,
    model: currentModel,
  };
  let nextAttempts = attempts + (judgeable ? 1 : 0);
  let decided = null;
  let judged = false;

  const pref = prefetched && prefetched.prompt === trimmedPrompt ? prefetched.answers : null;

  if (judgeable) {
    judged = true;
    try {
      const result = pref
        ? { answers: pref }
        : await judge({
            state: buildDifficultyState({
              prompt: trimmedPrompt,
              window: shareWindow ? history : [],
              cwd: ctx?.cwd,
            }),
            questions: buildDifficultyQuestions(),
            signal: AbortSignal.timeout(timeoutMs),
          });
      decided = routeFromDifficulty(result?.answers, { threshold, frontierThreshold });
    } catch {
      nextAttempts = attempts + 1;
      const failed = {
        task,
        attempts: nextAttempts,
        cooldown: FAILURE_COOLDOWN_TURNS,
        tier: held.tier,
        model: held.key,
        thinking: held.thinking,
        base: base?.key ?? branchState?.base ?? null,
      };
      return {
        judged: true,
        nextState: failed,
        entry: {
          at: clock(),
          sessionId,
          actual: { key: actualKey, thinking: actualThinking },
          wouldBe: {
            tier: held.tier,
            key: held.key,
            thinking: held.thinking ?? selected,
          },
          difficulty: null,
          gateReason: boundary.reason,
          decisionReason: "judge-failed",
          promptHash: promptHash(trimmedPrompt),
        },
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

  if (next.key && cooling.includes(next.key)) {
    const tier = decided?.tier ?? next.tier ?? BASE_TIER;
    const pick = chooseModelForTier(
      fitting(liveOffers, contextTokens),
      tier,
      tiers,
      undefined,
      selected,
    );
    if (pick && pick.key !== next.key) {
      next = {
        outcome: "failover",
        model: pick.model,
        key: pick.key,
        thinking: pick.thinking ?? next.thinking ?? selected,
        tier,
        warning: null,
      };
    }
  }

  const nextTier = next.tier ?? held.tier;
  const nextState = {
    task,
    attempts: nextAttempts,
    cooldown,
    tier: nextTier,
    model: next.key,
    thinking: next.thinking,
    base: base?.key ?? branchState?.base ?? null,
  };

  const wouldTier =
    decided?.escalate === true
      ? decided.tier
      : decided && decided.escalate === false
        ? BASE_TIER
        : (next.tier ?? nextTier);

  return {
    judged,
    nextState,
    entry: {
      at: clock(),
      sessionId,
      actual: { key: actualKey, thinking: actualThinking },
      wouldBe: {
        tier: wouldTier,
        key: next.key ?? held.key,
        thinking: next.thinking ?? held.thinking ?? selected,
      },
      difficulty: decided?.difficulty ?? null,
      gateReason: boundary.reason,
      decisionReason: decisionReason(decided, next),
      promptHash: promptHash(trimmedPrompt),
    },
  };
}
