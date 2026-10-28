// parent-physical.mjs — resolve the parent's physical model when the selection is router/auto.
//
// Cross-family reviewers need a family, but the parent's ctx.model is the virtual
// router/auto entry. pi records the model that answered on assistant messages; before
// the first route, fall back to the configured base tier.

import { readRouterConfig } from "./config.mjs";
import { chooseModelForTier, modelKey } from "./model-battery.mjs";

export const ROUTER_AUTO_KEY = "router/auto";

export function isRouterAuto(model) {
  return modelKey(model) === ROUTER_AUTO_KEY;
}

/** Physical model pinned on a subagent child (cross-family or per-type), not router/auto. */
export function pinnedPhysicalModelKey(request) {
  for (const candidate of [request?.previous?.model, request?.model]) {
    const key = modelKey(candidate);
    if (key && key !== ROUTER_AUTO_KEY) return key;
  }
  return null;
}

/** Newest assistant message on the branch that ran a physical model. */
export function lastRoutedPhysicalKey(branch) {
  const list = Array.isArray(branch) ? branch : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const entry = list[i];
    if (entry?.type !== "message" || entry?.message?.role !== "assistant") continue;
    const key = modelKey(entry.message?.model);
    if (key && key !== ROUTER_AUTO_KEY) return key;
  }
  return null;
}

function candidateModels(ctx) {
  const scoped = ctx?.scopedModels;
  if (Array.isArray(scoped) && scoped.length) {
    return scoped.map((entry) => entry?.model ?? entry).filter(Boolean);
  }
  const listed = ctx?.modelRegistry?.getAvailable?.();
  return Array.isArray(listed) ? listed : [];
}

/**
 * When cross-family runs in the parent session, supply the physical model key the
 * router is effectively on. Returns null when the parent is already physical.
 */
export function physicalParentKeyForCrossFamily(parentModel, ctx, configPath) {
  if (!isRouterAuto(parentModel)) return null;
  const routed = lastRoutedPhysicalKey(ctx?.sessionManager?.getBranch?.() ?? []);
  if (routed) return routed;
  const tiers = readRouterConfig(configPath);
  const offers = candidateModels(ctx);
  const cap = ctx?.thinkingLevel ?? null;
  const base = chooseModelForTier(offers, "base", tiers, undefined, cap);
  return base?.key ?? null;
}
