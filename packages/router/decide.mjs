// decide.mjs — what a difficulty rating does to the model in force.
//
// The pure half of route(): given the rating, the models on offer and the
// decision already held, say whether to escalate, hold, or step back down. No
// I/O and no pi types, so every branch is covered by node --test; index.ts
// keeps the state, the judge calls and the notifications.

import { chooseModelForTier, pairOrder, thinkingRank, tierOf, tierRank } from "./model-battery.mjs";

/** Room the next request needs beyond what the last one read. */
const CONTEXT_GROWTH_MARGIN = 1.05;
/** Output and reasoning tokens to keep free in the target window. */
const OUTPUT_RESERVE = 16000;

/** The model inside a `{ model, thinkingLevel }` scope wrapper, or the entry. */
export function unwrap(entry) {
  const value = entry?.model ?? entry;
  return value ?? null;
}

/**
 * Candidates the next request could fit inside.
 *
 * The base model here reads 1M tokens while the Codex frontier models hold
 * 272K, and this machine's p90 request context is 452K. Escalating anyway
 * would compact the session — losing the context the escalation was meant to
 * reason over.
 */
export function fitting(offers, contextTokens) {
  const used = contextTokens * CONTEXT_GROWTH_MARGIN + OUTPUT_RESERVE;
  if (!Number.isFinite(used) || used <= 0) return offers;
  return offers.filter((entry) => {
    const window = Number(unwrap(entry)?.contextWindow);
    if (!Number.isFinite(window) || window <= 0) return true; // unknown, not empty
    return used <= window;
  });
}

/** Raise thinking, never lower it, for a model that already fits the tier. */
function raiseThinking(wanted, currentLevel) {
  if (!wanted) return currentLevel;
  return thinkingRank(wanted) > thinkingRank(currentLevel ?? "") ? wanted : currentLevel;
}

/** Escalation rank of what is running; base-tier tasks ignore mid pattern matches. */
function currentTierRank(held, tiers, baseTier) {
  if (held.tier && held.tier !== baseTier) return tierRank(held.tier);
  if (tierOf(held.key, tiers) === "frontier") return tierRank("frontier");
  return tierRank(baseTier);
}

/**
 * @param held     what is in force: `{ key, thinking, tier, model }`
 * @param base     the session baseline `{ key, model, thinking }`, or null
 * @returns `{ outcome, model, key, thinking, tier, warning }` where `warning` is
 *   `"too-big"` (no model of the tier fits the context), `"unavailable"` (none
 *   exists), or null.
 */
export function decideRoute({
  decided,
  offers,
  tiers,
  contextTokens,
  held,
  base,
  selected,
  boundary,
  baseTier = "base",
}) {
  const hold = { outcome: "held", ...held, warning: null };
  if (!decided) return hold;
  if (decided.forced) {
    const fittingOffers = fitting(offers, contextTokens);
    const pick = chooseModelForTier(fittingOffers, decided.tier, tiers, undefined, selected);
    if (!pick) {
      return {
        ...hold,
        outcome: `no-${decided.tier}-model`,
        warning: offers.length > fittingOffers.length ? "too-big" : "unavailable",
      };
    }
    return {
      outcome: "forced",
      model: pick.model,
      key: pick.key,
      thinking: pick.thinking ?? selected,
      tier: decided.tier,
      warning: null,
    };
  }
  // No usable rating: keep what is running. Never a reason to spend less.
  if (decided.escalate === null) return { ...hold, outcome: "no-rating" };

  if (!decided.escalate) {
    // Easy task. Only a task boundary may come back down: a stuck turn rated
    // easy is still a stuck turn.
    if (!boundary || !base?.model) return hold;
    return {
      outcome: held.tier !== baseTier ? "stepped-down" : "held",
      model: base.model,
      key: base.key,
      thinking: base.thinking ?? selected,
      tier: baseTier,
      warning: null,
    };
  }

  const fittingOffers = fitting(offers, contextTokens);
  const pick = chooseModelForTier(fittingOffers, decided.tier, tiers, undefined, selected);
  if (!pick) {
    return {
      ...hold,
      outcome: `no-${decided.tier}-model`,
      warning: offers.length > fittingOffers.length ? "too-big" : "unavailable",
    };
  }

  const targetThinking = pick.thinking ?? selected;
  const currentRank = currentTierRank(held, tiers, baseTier);
  const currentPairOrder = pairOrder(held.key, held.thinking, decided.tier, tiers);
  const capExceeded = thinkingRank(held.thinking ?? "") > thinkingRank(selected);
  const targetRank = tierRank(decided.tier);
  const betterPair =
    targetRank > currentRank ||
    (targetRank === currentRank &&
      (capExceeded || (currentPairOrder !== null && pick.order < currentPairOrder)));

  if (pick.key === held.key) {
    // Same model: raise to the selected pair, but never lower it unless the
    // user explicitly lowered the virtual model's cap.
    if (tierOf(held.key, tiers) !== decided.tier) return hold;
    return {
      ...hold,
      thinking: capExceeded ? targetThinking : raiseThinking(targetThinking, held.thinking),
      tier: decided.tier,
    };
  }
  if (!betterPair) return hold;
  // The pair is selected as a unit. Do not choose one model first and then
  // silently clamp its thinking under the cap.
  return {
    outcome: "escalated",
    model: pick.model,
    key: pick.key,
    thinking: targetThinking ?? held.thinking,
    tier: decided.tier,
    warning: null,
  };
}
