// Pure footer layout logic for the pi-footer extension. No pi imports —
// testable with `node --test`, colors applied via the injected `apply` fn.

const ANSI_RE = /\u001b\[[0-9;]*m/g;

/** Visible width of a string with ANSI color codes stripped. */
export function visibleWidth(str) {
  return str.replace(ANSI_RE, "").length;
}

/** 1234 -> "1.2k", 2500000 -> "2.5M", 42 -> "42". */
export function fmtTokens(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

/** 0.0042 -> "$0.0042", 0.012345 -> "$0.012", 2 -> "$2.000". */
export function fmtCost(c) {
  if (c === 0) return "$0.000";
  if (c < 0.01) return `$${c.toFixed(4)}`;
  return `$${c.toFixed(3)}`;
}

/** pi thinking level -> theme color token. */
const THINK_COLOR = {
  off: "thinkingOff",
  minimal: "thinkingMinimal",
  low: "thinkingLow",
  medium: "thinkingMedium",
  high: "thinkingHigh",
  xhigh: "thinkingXhigh",
  max: "thinkingMax",
};

export function thinkColor(level) {
  return THINK_COLOR[level] || "thinkingHigh";
}

/**
 * Lay one line of footer segments into `width` columns.
 *
 * A segment is `{ text, color? }`; `apply(color, text)` renders a colored
 * segment (pi's `theme.fg`). Segments within a block are adjacent — bake
 * separators into segment text (e.g. `" ~high"`). A single space separates
 * the left and right blocks.
 *
 * Under pressure, in order: trailing right segments drop (branch first),
 * the model label truncates with an ellipsis, then left segments drop from
 * the end (thinking badge before model).
 */
export function composeLine(left, right, width, apply) {
  const fmt = (segs) => segs.map((s) => (s.color ? apply(s.color, s.text) : s.text)).join("");
  const vis = (segs) => visibleWidth(fmt(segs));

  let l = left.slice();
  let r = right.slice();
  const overflow = () => vis(l) + vis(r) + (l.length && r.length ? 1 : 0) > width;

  while (r.length > 1 && overflow()) r.pop();

  if (l.length && r.length && overflow()) {
    const model = l[0];
    const rest = l.slice(1);
    const room = width - vis(rest) - vis(r) - 2; // block gap + ellipsis
    if (room >= 1) l = [{ ...model, text: model.text.slice(0, room) + "…" }, ...rest];
  }

  while (l.length > 1 && overflow()) l.pop();
  while (l.length && overflow()) l.pop();

  const leftStr = fmt(l);
  const rightStr = fmt(r);
  const fill = Math.max(0, width - vis(l) - vis(r) - (l.length && r.length ? 1 : 0));
  return leftStr + (l.length && r.length ? " " + " ".repeat(fill) : "") + rightStr;
}
