import { modelKey } from "./model-battery.mjs";

// Usage-cap recognition for provider errors Pi has already flattened to text.
//
// Check usage before overload. A leaked WebSocket payload contains both
// "usage_limit_reached" and a bare 429, and the 429 must not win.

const CONTEXT_OVERFLOW =
  /exceeds the context window|context[_ ]length[_ ]exceeded|prompt is too long|maximum context length/i;

const USAGE =
  /you have hit your chatgpt usage limit|usage_limit_reached|usage_not_included|usage limit has been reached|insufficient_quota|quota exceeded/i;

const OVERLOAD =
  /overloaded|server_is_overloaded|server_busy|at capacity|high demand|service.?(is.?)?(temporarily.?)?unavailable|rate.?limit|too many requests|(?<![a-z0-9])(429|503)(?![a-z0-9])/i;

/**
 * Cooldown when a usage-limit message has no "Try again in ~N min" suffix.
 * A short throttle and a hard cap share that wording, so the wait stays short.
 */
export const SHORT_USAGE_COOLDOWN_MS = 2 * 60 * 1000;

/** What kind of provider failure `text` is, or null when it is neither. */
export function classifyProviderError(text) {
  const value = String(text ?? "");
  // Overflow retries stay on the same model. Check them before usage and
  // overload so a window error is never cooled down or failed over.
  if (CONTEXT_OVERFLOW.test(value)) return "context-overflow";
  if (USAGE.test(value)) return "usage";
  if (OVERLOAD.test(value)) return "overload";
  return null;
}

/**
 * In-memory usage caps, keyed by physical "provider/model".
 *
 * Nothing here is written to disk. `active` drops keys whose deadline has
 * passed, including a deadline equal to `now`.
 */
export function createUsageCaps() {
  const until = new Map();
  const prune = (now) => {
    for (const [key, expiry] of until) if (!(expiry > now)) until.delete(key);
  };
  return {
    record(key, ms, at) {
      if (!key || !(ms > 0) || !Number.isFinite(at)) return;
      const expiry = at + ms;
      const current = until.get(key);
      if (current === undefined || expiry > current) until.set(key, expiry);
    },
    active(now) {
      prune(now);
      return [...until.keys()];
    },
  };
}

/** Milliseconds to cool a model down after a usage-limit `text`. */
export function usageCooldownMs(text) {
  const match = /try again in ~(\d+) min/i.exec(String(text ?? ""));
  if (!match) return SHORT_USAGE_COOLDOWN_MS;
  const minutes = Number(match[1]);
  if (!Number.isFinite(minutes) || minutes <= 0) return SHORT_USAGE_COOLDOWN_MS;
  return minutes * 60 * 1000;
}

function assistantModelKey(message) {
  if (!message || typeof message !== "object") return null;
  const provider = message.provider ?? message.model?.provider ?? "";
  const id =
    typeof message.model === "string"
      ? message.model
      : (message.model?.id ?? message.modelId ?? "");
  if (!provider || !id) return null;
  return `${provider}/${id}`;
}

/**
 * The usage cap on the last assistant message, or null.
 *
 * A later successful assistant message means the turn recovered, so an earlier
 * error is not a cap. Overloads, overflows and other errors are not caps.
 */
export function usageCapFromMessages(messages) {
  let last = null;
  for (const entry of Array.isArray(messages) ? messages : []) {
    const message = entry?.message ?? entry;
    if (message?.role === "assistant") last = message;
  }
  if (last?.stopReason !== "error") return null;
  const text = typeof last.errorMessage === "string" ? last.errorMessage : "";
  if (classifyProviderError(text) !== "usage") return null;
  const key = assistantModelKey(last);
  if (!key) return null;
  return { key, ms: usageCooldownMs(text) };
}

/** Drop offers whose physical provider/model is in `coolingKeys`. */
export function offersExceptCooling(offers, coolingKeys) {
  const cooling = new Set(coolingKeys ?? []);
  return (Array.isArray(offers) ? offers : []).filter((entry) => {
    const key = modelKey(entry);
    return !key || !cooling.has(key);
  });
}
