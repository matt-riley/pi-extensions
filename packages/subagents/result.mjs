// result.mjs — truncate, usage line, last-assistant extract, turn-cap policy.

export const RESULT_CAP = 50 * 1024;
export const DEFAULT_MAX_TURNS = 30;
export const GRACE_TURNS = 2;

export function truncateText(text, cap = RESULT_CAP) {
  const s = text == null ? "" : String(text);
  if (s.length <= cap) return s;
  return `${s.slice(0, cap)}\n…`;
}

export function fallbackDescription(task, max = 40) {
  const t = String(task ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "task";
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

export function formatTokens(count) {
  const n = Number(count);
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 100_000) {
    const k = (n / 1000).toFixed(1);
    return k.endsWith(".0") ? `${k.slice(0, -2)}k` : `${k}k`;
  }
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "0s";
  if (n < 1000) return `${Math.round(n)}ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`;
  const minutes = Math.floor(n / 60_000);
  const seconds = Math.round((n % 60_000) / 1000);
  return `${minutes}m${seconds}s`;
}

export function formatUsageLine({ turns, tokens, durationMs } = {}) {
  const parts = [];
  if (Number.isFinite(turns) && turns > 0) {
    parts.push(`${turns} turn${turns === 1 ? "" : "s"}`);
  }
  if (Number.isFinite(tokens) && tokens > 0) {
    parts.push(`${formatTokens(tokens)} tok`);
  }
  if (Number.isFinite(durationMs) && durationMs >= 0) {
    parts.push(formatDuration(durationMs));
  }
  return parts.join(" · ");
}

export function formatResult({ agent, description, status, turns, tokens, durationMs, text, note } = {}) {
  const who = agent || "agent";
  const label = description ? `[${who}] ${description} — ${status}` : `[${who}] — ${status}`;
  const stats = formatUsageLine({ turns, tokens, durationMs });
  const header = stats ? `${label} · ${stats}` : label;
  const body = truncateText(text);
  const extra = note ? `\n${note}` : "";
  return body ? `${header}\n\n${body}${extra}` : `${header}${extra}`;
}

export function tokensFromUsage(usage) {
  if (!usage || typeof usage !== "object") return 0;
  const total = Number(usage.total);
  if (Number.isFinite(total) && total > 0) return total;
  const input = Number(usage.input) || 0;
  const output = Number(usage.output) || 0;
  const cacheWrite = Number(usage.cacheWrite) || 0;
  return input + output + cacheWrite;
}

export function extractLastAssistantText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message || message.role !== "assistant") continue;
    const content = message.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) continue;
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && part.type === "text" && typeof part.text === "string") return part.text;
        return "";
      })
      .join("");
  }
  return "";
}

export function clampMaxTurns(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  const t = Math.trunc(n);
  if (t < 1) return 1;
  if (t > DEFAULT_MAX_TURNS) return DEFAULT_MAX_TURNS;
  return t;
}

export function resolveMaxTurns(frontmatterMax, toolMax) {
  let cap = DEFAULT_MAX_TURNS;
  const fm = clampMaxTurns(frontmatterMax);
  const tool = clampMaxTurns(toolMax);
  if (fm != null) cap = Math.min(cap, fm);
  if (tool != null) cap = Math.min(cap, tool);
  return cap;
}

// After each turn_end: continue, send the wrap-up steer, or abort.
// At maxTurns → wrap. Then GRACE_TURNS more turns. Then abort.
export function turnAction(turns, maxTurns, graceTurns = GRACE_TURNS) {
  const cap = clampMaxTurns(maxTurns) ?? DEFAULT_MAX_TURNS;
  const grace = Number.isFinite(graceTurns) && graceTurns >= 0 ? Math.trunc(graceTurns) : GRACE_TURNS;
  if (turns < cap) return "continue";
  if (turns === cap) return "wrap";
  if (turns < cap + grace) return "continue";
  return "abort";
}
