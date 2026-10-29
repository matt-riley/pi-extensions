/** Toast stack and queue — no Pi imports; width helpers are injected for tests. */

/** @typedef {"info" | "warning" | "error"} Severity */
/** @typedef {{ id: number, text: string, severity: Severity }} Toast */
/** @typedef {(token: "accent" | "warning" | "error" | "dim" | "border", text: string) => string} Paint */

const TOKEN = { info: "accent", warning: "warning", error: "error" };

/** Strip control characters and collapse whitespace so text cannot inject escapes or extra rows. */
export function oneLine(text) {
  let cleaned = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if ((code >= 0 && code <= 31) || (code >= 127 && code <= 159)) cleaned += " ";
    else cleaned += ch;
  }
  return cleaned.replace(/\s+/g, " ").trim();
}

/** Greedy word wrap by visible columns, capped at maxLines (last line ends with … when cut). */
export function wrap(text, width, maxLines, { visibleWidth, truncateToWidth }) {
  if (width < 1) return [];
  const lines = [];
  let line = "";
  for (const word of text.split(" ")) {
    const next = line ? `${line} ${word}` : word;
    if (visibleWidth(next) <= width) {
      line = next;
      continue;
    }
    if (line) lines.push(line);
    line = visibleWidth(word) > width ? truncateToWidth(word, width, "…") : word;
  }
  if (line || lines.length === 0) lines.push(line);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = truncateToWidth(`${kept[maxLines - 1]} …`, width, "…");
    return kept;
  }
  return lines;
}

export function createToastStack(paint, piTui, maxLines = 3) {
  let toasts = [];
  let cacheWidth = -1;
  let cache = [];

  return {
    setToasts(next) {
      toasts = [...next];
      this.invalidate();
    },
    invalidate() {
      cacheWidth = -1;
    },
    render(width) {
      if (width === cacheWidth) return cache;
      const out = [];
      if (width >= 1) {
        for (const toast of toasts) out.push(...card(toast, width, paint, piTui, maxLines));
      }
      cache = out.map((line) => piTui.truncateToWidth(line, width, ""));
      cacheWidth = width;
      return cache;
    },
  };
}

function card(toast, width, paint, piTui, maxLines) {
  const p = paint;
  if (width < 5)
    return [p(TOKEN[toast.severity], piTui.truncateToWidth(oneLine(toast.text), width, ""))];
  const inner = width - 4;
  const words = wrap(oneLine(toast.text), inner, maxLines, piTui);
  const rule = "─".repeat(width - 2);
  const lines = [p("border", `╭${rule}╮`)];
  for (const w of words) {
    const pad = " ".repeat(Math.max(0, inner - piTui.visibleWidth(w)));
    lines.push(p("border", "│ ") + p(TOKEN[toast.severity], w) + pad + p("border", " │"));
  }
  lines.push(p("border", `╰${rule}╯`));
  return lines;
}

/**
 * @param {(toasts: readonly Toast[]) => void} onChange
 * @param {{ maxVisible?: number, clock?: { setTimeout(fn: () => void, ms: number): unknown, clearTimeout(handle: unknown): void } }} [opts]
 */
export function createToastQueue(onChange, opts = {}) {
  const maxVisible = opts.maxVisible ?? 3;
  const clock = opts.clock ?? globalThis;
  let next = 1;
  let visible = [];
  /** @type {Map<number, unknown>} */
  const timers = new Map();
  let disposed = false;

  const drop = (id) => {
    const handle = timers.get(id);
    if (handle !== undefined) clock.clearTimeout(handle);
    timers.delete(id);
    visible = visible.filter((t) => t.id !== id);
  };

  const expire = (id) => {
    if (disposed) return;
    drop(id);
    onChange([...visible]);
  };

  return {
    get size() {
      return visible.length;
    },
    show(text, severity = "info", ms = 4000) {
      if (disposed) return;
      const toast = { id: next++, text, severity };
      visible.push(toast);
      while (visible.length > maxVisible) drop(visible[0].id);
      timers.set(
        toast.id,
        clock.setTimeout(() => expire(toast.id), ms),
      );
      onChange([...visible]);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const handle of timers.values()) clock.clearTimeout(handle);
      timers.clear();
      visible = [];
    },
  };
}
