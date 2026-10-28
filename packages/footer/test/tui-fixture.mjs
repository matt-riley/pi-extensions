// Stand-in for pi-tui's width helpers, which the pi host supplies at runtime.
// It counts every non-ASCII grapheme except "…" as two columns, so a layout
// that measures with anything other than the injected helpers gets it wrong.
import { stripVTControlCharacters } from "node:util";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const cells = (segment) => (/^[\x20-\x7e…]$/.test(segment) ? 1 : 2);

export function visibleWidth(text) {
  let width = 0;
  for (const { segment } of graphemes.segment(stripVTControlCharacters(text)))
    width += cells(segment);
  return width;
}

// Like pi-tui, the default ellipsis is "..." and a reset precedes and follows it.
function truncateToWidth(text, maxWidth, ellipsis = "...") {
  if (maxWidth <= 0) return "";
  if (visibleWidth(text) <= maxWidth) return text;
  const room = maxWidth - visibleWidth(ellipsis);
  if (room < 0) return "";
  let kept = "",
    used = 0;
  for (const { segment } of graphemes.segment(stripVTControlCharacters(text))) {
    if (used + cells(segment) > room) break;
    kept += segment;
    used += cells(segment);
  }
  return kept + "\u001b[0m" + ellipsis + "\u001b[0m";
}

export const tui = { visibleWidth, truncateToWidth };
