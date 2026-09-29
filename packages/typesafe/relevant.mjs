// relevant.mjs — read_relevant: the lines of a file that matter to a goal.
//
// Two passes of select-don't-generate: rate coarse line windows against the
// goal, then split any large winner and rate again, so the agent gets a few
// tight, numbered ranges instead of the whole file. Every range is copied from
// the file, never written by the model.

import {
  mapPool,
  rateCandidates,
  splitWindows,
  topIndices,
  WINDOW_RELEVANCE,
} from "../../shared/spans.mjs";

const WHOLE_FILE_LINES = 120;
const REFINE_ABOVE = 60;
const PAD = 3;
const MAX_OUTPUT_LINES = 400;
function merge(ranges) {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const out = [];
  for (const range of sorted) {
    const last = out.at(-1);
    if (last && range.start <= last.end + 1) last.end = Math.max(last.end, range.end);
    else out.push({ ...range });
  }
  return out;
}

export async function selectRelevantRanges({ text, path, goal, maxRanges = 3, ask, signal }) {
  const lines = text.split("\n");
  const total = lines.length;
  if (total <= WHOLE_FILE_LINES)
    return { total, whole: true, ranges: [{ start: 1, end: total }], lines };

  const context = { goal, file: path };
  const rate = (windows, max) =>
    rateCandidates({
      context,
      candidates: windows.map((w) => w.text),
      ...WINDOW_RELEVANCE,
      ask,
      signal,
      maxCandidates: 60,
      maxChars: 1500,
    }).then((ratings) => {
      if (ratings.length > 0 && ratings.every((r) => r === null)) {
        throw new Error("Jev returned no usable ratings");
      }
      return topIndices(ratings, { threshold: 0.5, max }).map((index) => windows[index]);
    });

  const picked = await rate(splitWindows(text, { size: 25, maxWindows: 60 }), maxRanges);
  const refined = await mapPool(picked, async (window) => {
    if (window.end - window.start + 1 <= REFINE_ABOVE) return [window];
    const subs = splitWindows(window.text, { size: 15, maxWindows: 40 }).map((s) => ({
      start: window.start + s.start - 1,
      end: window.start + s.end - 1,
      text: s.text,
    }));
    const best = await rate(subs, 2);
    return best.length > 0 ? best : [window];
  });
  const ranges = merge(
    refined
      .flat()
      .map((w) => ({ start: Math.max(1, w.start - PAD), end: Math.min(total, w.end + PAD) })),
  );
  return { total, whole: false, ranges, lines };
}

export function formatRanges({ path, total, whole, ranges, lines }) {
  if (ranges.length === 0) {
    return `No range of ${path} (${total} lines) was judged relevant. Use read if you need the file.`;
  }
  const width = String(total).length;
  let budget = MAX_OUTPUT_LINES;
  const blocks = [];
  for (const { start, end } of ranges) {
    if (budget <= 0) break;
    const stop = Math.min(end, start + budget - 1);
    const body = lines
      .slice(start - 1, stop)
      .map((line, i) => `${String(start + i).padStart(width)}  ${line}`)
      .join("\n");
    blocks.push(`── ${path}:${start}-${stop} ──\n${body}`);
    budget -= stop - start + 1;
  }
  const note = whole
    ? `${total} lines (short file, shown in full).`
    : `${total} lines total; showing ${blocks.length} range(s). Use read with offset/limit for more.`;
  return `${blocks.join("\n\n")}\n\n${note}`;
}
