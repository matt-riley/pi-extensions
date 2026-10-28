// The effective ladder at a thinking cap. Reporting only: routing does not
// read this. A tier that resolves to the same model and the same thinking
// level as base has collapsed, and a tier whose pairs all sit above the cap
// has been filtered out.

import { chooseModelForTier, thinkingRank } from "./model-battery.mjs";

const TIERS = ["base", "mid", "frontier"];

function ladderName(key) {
  const id =
    String(key ?? "")
      .split("/")
      .pop() ?? "";
  const tail = id.split("-").pop() ?? id;
  if (/^[a-z][a-z]+$/i.test(tail)) return tail[0].toUpperCase() + tail.slice(1).toLowerCase();
  return id || "?";
}

/**
 * What each tier would resolve to at `cap`.
 *
 * A pair with no thinking of its own runs at the cap. The same model never
 * steps down, so a lower pair on the base model is shown at the base level.
 */
export function routingLadder({ offers, tiers, cap } = {}) {
  const selected = cap || "medium";
  const resolved = {};
  for (const tier of TIERS) {
    const pick = chooseModelForTier(offers, tier, tiers, undefined, selected);
    if (!pick) {
      resolved[tier] = null;
      continue;
    }
    let thinking = pick.thinking ?? selected;
    const base = resolved.base;
    if (base && pick.key === base.key && thinkingRank(thinking) < thinkingRank(base.thinking)) {
      thinking = base.thinking;
    }
    resolved[tier] = { key: pick.key, thinking, name: ladderName(pick.key) };
  }

  const line = TIERS.map((tier) => {
    const entry = resolved[tier];
    if (!entry) return `${tier} (none)`;
    const same =
      tier !== "base" &&
      resolved.base &&
      entry.key === resolved.base.key &&
      entry.thinking === resolved.base.thinking;
    return `${tier} ${entry.name}@${entry.thinking}${same ? " (same as base)" : ""}`;
  }).join(" · ");

  const warnings = [];
  for (const tier of ["mid", "frontier"]) {
    const entry = resolved[tier];
    if (!entry) warnings.push(`${tier} is filtered out by the ${selected} cap`);
    else if (
      resolved.base &&
      entry.key === resolved.base.key &&
      entry.thinking === resolved.base.thinking
    ) {
      warnings.push(`${tier} collapses onto base`);
    }
  }
  return { line, warnings, tiers: resolved };
}
