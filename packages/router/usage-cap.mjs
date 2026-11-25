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
 * A short throttle and a hard cap share that wording, so the first wait stays
 * short. Repeat no-suffix caps on the same pair, after that window expires,
 * step up through 15 minutes, 1 hour, and 4 hours.
 */
export const SHORT_USAGE_COOLDOWN_MS = 2 * 60 * 1000;

/**
 * No-suffix waits after a usage cap: 2 minutes, 15 minutes, 1 hour, then 4
 * hours. Four hours is the top of the 4–5 hour cap; later repeats stay there.
 * A provider-stated "Try again in ~N min" does not use this ladder.
 */
const USAGE_COOLDOWN_LADDER_MS = [
  SHORT_USAGE_COOLDOWN_MS,
  15 * 60 * 1000,
  60 * 60 * 1000,
  4 * 60 * 60 * 1000,
];

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
 * passed, including a deadline equal to `now`. `record` still stores an
 * exact wait. `recordCap` applies the no-suffix ladder, and `clear` drops
 * that pair's streak after a successful turn on it.
 */
export function createUsageCaps() {
  const until = new Map();
  const streak = new Map();
  const prune = (now) => {
    for (const [key, expiry] of until) if (!(expiry > now)) until.delete(key);
  };
  const record = (key, ms, at) => {
    if (!key || !(ms > 0) || !Number.isFinite(at)) return;
    const expiry = at + ms;
    const current = until.get(key);
    if (current === undefined || expiry > current) until.set(key, expiry);
  };
  return {
    record,
    recordCap(key, text, at) {
      if (!key || !Number.isFinite(at)) return;
      const stated = providerUsageWaitMs(text);
      if (stated != null) {
        record(key, stated, at);
        return stated;
      }
      const current = until.get(key);
      if (current !== undefined && current > at) return current - at;
      const step = Math.min((streak.get(key) ?? 0) + 1, USAGE_COOLDOWN_LADDER_MS.length);
      streak.set(key, step);
      const ms = USAGE_COOLDOWN_LADDER_MS[step - 1];
      record(key, ms, at);
      return ms;
    },
    clear(key) {
      if (!key) return;
      until.delete(key);
      streak.delete(key);
    },
    active(now) {
      prune(now);
      return [...until.keys()];
    },
  };
}

/** Provider-stated wait from "Try again in ~N min", or null. */
function providerUsageWaitMs(text) {
  const match = /try again in ~(\d+) min/i.exec(String(text ?? ""));
  if (!match) return null;
  const minutes = Number(match[1]);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return minutes * 60 * 1000;
}

/** Milliseconds the usage-limit `text` itself asks for, ignoring the ladder. */
export function usageCooldownMs(text) {
  return providerUsageWaitMs(text) ?? SHORT_USAGE_COOLDOWN_MS;
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

function lastAssistant(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const message = list[i]?.message ?? list[i];
    if (message?.role === "assistant") return message;
  }
  return null;
}

/**
 * The usage cap on the last assistant message, or null.
 *
 * A later successful assistant message means the turn recovered, so an earlier
 * error is not a cap. Overloads, overflows and other errors are not caps.
 * `ms` is the wait in the text itself; `recordCap` applies the ladder.
 */
export function usageCapFromMessages(messages) {
  const last = lastAssistant(messages);
  if (last?.stopReason !== "error") return null;
  const text = typeof last.errorMessage === "string" ? last.errorMessage : "";
  if (classifyProviderError(text) !== "usage") return null;
  const key = assistantModelKey(last);
  if (!key) return null;
  return { key, ms: usageCooldownMs(text), text };
}

/**
 * The physical key of the last assistant message when that turn succeeded.
 * Only a completed assistant turn (`stopReason` `stop`) counts. Aborted
 * turns, errors, and any other stop reason are not a success.
 */
export function successfulTurnKey(messages) {
  const last = lastAssistant(messages);
  if (!last || last.stopReason !== "stop") return null;
  return assistantModelKey(last);
}

/** Drop offers whose physical provider/model is in `coolingKeys`. */
export function offersExceptCooling(offers, coolingKeys) {
  const cooling = new Set(coolingKeys ?? []);
  return (Array.isArray(offers) ? offers : []).filter((entry) => {
    const key = modelKey(entry);
    return !key || !cooling.has(key);
  });
}
