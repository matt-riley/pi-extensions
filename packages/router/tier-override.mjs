// tier-override.mjs — parse !base / !mid / !frontier prefixes and build a forced decision.

const PREFIX = /^!(frontier|mid|base)(?:\s+|$)/i;

/** @returns {{ tier: "base"|"mid"|"frontier", rest: string } | null} */
export function parseTierOverridePrefix(text) {
  const raw = String(text ?? "");
  const match = raw.match(PREFIX);
  if (!match) return null;
  const tier = match[1].toLowerCase();
  if (tier !== "base" && tier !== "mid" && tier !== "frontier") return null;
  const rest = raw.slice(match[0].length).trimStart();
  return { tier, rest };
}

/** Synthetic rating that skips the judge but flows through decideRoute. */
export function forcedTierDecision(tier) {
  return {
    forced: true,
    escalate: true,
    tier,
    difficulty: null,
    reason: "forced",
  };
}
