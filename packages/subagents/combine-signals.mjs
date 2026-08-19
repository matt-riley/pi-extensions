// combine-signals.mjs — merge zero or more AbortSignals into one.

export function combineSignals(signals) {
  const present = (signals || []).filter((signal) => signal != null);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}
