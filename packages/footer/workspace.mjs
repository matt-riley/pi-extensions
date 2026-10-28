// Pure footer layout logic for the pi-footer extension. No pi imports —
// testable with `node --test`. Colours come from the injected `apply` fn, and
// widths from pi-tui's injected `visibleWidth`/`truncateToWidth`, the same
// helpers pi uses to reject a line wider than the terminal.

import { stripVTControlCharacters } from "node:util";

/**
 * Segment text cut to `width` columns by pi-tui. Its resets are dropped so the
 * theme colour that `apply` adds covers the ellipsis too.
 */
const cut = (tui, text, width) => stripVTControlCharacters(tui.truncateToWidth(text, width, "…"));

/** Work state describes activity, never test success or task completion. */
export function workLabel(busy, statuses) {
  return statuses?.has("plan-mode") ? "planning" : busy ? "working" : "ready";
}

export function workspaceLine(data, width, apply, tui) {
  const clean = (value) => stripVTControlCharacters(String(value ?? "")).replace(/\p{Cc}/gu, "");
  const left = [
    {
      text: clean(data.project) + (data.branch ? " · " + clean(data.branch) : ""),
      color: "muted",
    },
  ];
  const right = [
    {
      text: clean(data.state) + (data.savedDraft ? " · draft saved" : ""),
      color: data.state === "ready" ? "muted" : "warning",
    },
  ];
  if (data.percent != null)
    right.push({ text: " · " + Math.round(data.percent) + "%", color: ctxColor(data.percent) });
  if (data.model) right.push({ text: " · " + clean(data.model), color: "accent" });
  if (data.level) right.push({ text: " ~" + clean(data.level), color: thinkColor(data.level) });
  return composeLine(left, right, width, apply, tui);
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

/** Context-window fill percentage -> theme color token (verified tokens). */
export function ctxColor(percent) {
  if (percent >= 90) return "error";
  if (percent >= 75) return "warning";
  return "muted";
}

/**
 * Nerd Font v3 glyphs, verified against nerd-fonts-generated.css (v3.5.0).
 * Class names for provenance: nf-cod-robot \uec20, nf-fa-brain \uee9c,
 * nf-fa-arrow_up \uf062, nf-fa-arrow_down \uf063, nf-fa-dollar \uf155,
 * nf-fa-folder \uf07b, nf-cod-git_branch \uec6f, nf-fa-gauge_high \ued2f.
 *
 * All are BMP codepoints — exactly one JS code unit and one terminal cell —
 * so footer width math stays exact. Requires a Nerd Font in the terminal,
 * otherwise these render as tofu boxes.
 */
export const ICONS = {
  robot: "\uec20",
  brain: "\uee9c",
  arrowUp: "\uf062",
  arrowDown: "\uf063",
  dollar: "\uf155",
  folder: "\uf07b",
  gitBranch: "\uec6f",
  gauge: "\ued2f",
};

/**
 * Lay one line of footer segments into `width` columns.
 *
 * A segment is `{ text, color? }`; `apply(color, text)` renders a colored
 * segment (pi's `theme.fg`); `tui` is pi-tui's `{ visibleWidth, truncateToWidth }`. Segments within a block are adjacent — bake
 * separators into segment text (e.g. `" ~high"`). A single space separates
 * the left and right blocks.
 *
 * Under pressure, in order: trailing right segments drop (branch first),
 * the model label truncates with an ellipsis, then left segments drop from
 * the end (thinking badge before model).
 */
export function composeLine(left, right, width, apply, tui) {
  // theme.fg throws on unknown tokens (and kills pi via uncaughtException),
  // so paint never lets a bad color escape the footer renderer.
  const paint = (s) => {
    if (!s.color) return s.text;
    try {
      return apply(s.color, s.text);
    } catch {
      return s.text;
    }
  };
  const fmt = (segs) => segs.map(paint).join("");
  const vis = (segs) => tui.visibleWidth(fmt(segs));

  let l = left.slice();
  let r = right.slice();
  const overflow = () => vis(l) + vis(r) + (l.length && r.length ? 1 : 0) > width;

  while (r.length > 1 && overflow()) r.pop();

  if (l.length && r.length && overflow()) {
    const model = l[0];
    const rest = l.slice(1);
    const room = width - vis(rest) - vis(r) - 2; // block gap + ellipsis
    if (room >= 1) l = [{ ...model, text: cut(tui, model.text, room + 1) }, ...rest];
  }

  while (l.length > 1 && overflow()) l.pop();
  // Preserve a lone left segment when there is no right block; the final
  // clamp below can truncate it. When a right block exists, keep the existing
  // priority of preserving the right side.
  while (l.length && r.length && overflow()) l.pop();

  // A right block is normally several segments, so the loop above drops
  // trailing details until it fits. Extension statuses are one joined segment,
  // though; if that single segment is longer than the terminal there is nothing
  // left to drop. Clamp the surviving edge segment as a final hard guarantee.
  if (l.length && r.length && overflow()) {
    const room = width - vis(r) - 1;
    if (room <= 0) l = [];
    else l = [{ ...l[0], text: cut(tui, l[0].text, room) }, ...l.slice(1)];
  }
  if (r.length && overflow()) {
    const room = width - vis(l) - (l.length ? 1 : 0);
    if (room <= 0) r = [];
    else r = [{ ...r[0], text: cut(tui, r[0].text, room) }, ...r.slice(1)];
  }
  if (l.length && overflow()) {
    l = [{ ...l[0], text: cut(tui, l[0].text, width) }, ...l.slice(1)];
  }

  const leftStr = fmt(l);
  const rightStr = fmt(r);
  const fill = Math.max(0, width - vis(l) - vis(r) - (l.length && r.length ? 1 : 0));
  return leftStr + (l.length && r.length ? " " + " ".repeat(fill) : "") + rightStr;
}
