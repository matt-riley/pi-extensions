// spans.mjs — select-don't-generate helpers shared by safe-compact and the
// file tools in pi-typesafe.
//
// Code produces candidate spans (line windows, sentences); Jev rates them; code
// copies the winners. A rating can only pick what code offered, so a selected
// path or line range is always real. `ask` is injectable so callers test
// without a network.

import { askSystemOne } from "./systemone.mjs";

const DEFAULT_MAX_CANDIDATES = 40;
const DEFAULT_MAX_CANDIDATE_CHARS = 400;

// Number(null) is 0, which would read as a confident "no". Absent stays absent.
export function usable(raw) {
  if (raw === null || raw === undefined || (typeof raw === "string" && !raw.trim())) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export const yes = (answer) => (answer?.type === "noul" ? usable(answer.noul) : null);

/** Head-and-tail excerpt: the start says what it is, the end says how it ended. */
export function excerpt(text, max) {
  if (text.length <= max) return text;
  const head = Math.ceil(max * 0.65);
  const tail = max - head;
  return `${text.slice(0, head).trimEnd()} … ${text.slice(text.length - tail).trimStart()}`;
}

/** Fixed-size line windows with 1-based inclusive bounds; coarsened to fit `maxWindows`. */
export function splitWindows(text, { size = 25, maxWindows = 40 } = {}) {
  const lines = text.split("\n");
  const step = Math.max(size, Math.ceil(lines.length / maxWindows));
  const windows = [];
  for (let start = 0; start < lines.length; start += step) {
    const slice = lines.slice(start, start + step);
    windows.push({ start: start + 1, end: start + slice.length, text: slice.join("\n") });
  }
  return windows;
}

/** Bounded-parallel map that keeps input order. */
export async function mapPool(items, worker, concurrency = 8) {
  const results = Array.from({ length: items.length });
  let cursor = 0;
  const lanes = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(lanes);
  return results;
}

/**
 * Probability that each candidate satisfies `instruction`, one request per
 * candidate (run in parallel). Batching every candidate into one state array
 * looked cheaper but measurably degraded later items: on a real file the true
 * match scored below unrelated windows. Each candidate gets its own context.
 * Refer to it as `candidate` in the instruction; `context` is shared.
 */
export async function rateCandidates({
  context,
  candidates,
  instruction,
  criteria,
  ask = askSystemOne,
  signal,
  maxCandidates = DEFAULT_MAX_CANDIDATES,
  maxChars = DEFAULT_MAX_CANDIDATE_CHARS,
}) {
  const list = candidates.slice(0, maxCandidates).map((c) => excerpt(c, maxChars));
  return mapPool(list, async (candidate) => {
    const { answers } = await ask({
      state: { context, candidate },
      questions: {
        rating: {
          type: "noul",
          instructions: `${instruction} The candidate is \`candidate\`.`,
          ...(criteria && { criteria }),
        },
      },
      signal,
    });
    return yes(answers?.rating);
  });
}

/**
 * The wording for rating a file window against a goal. Measured on real files:
 * "is it relevant" rated every window 0.7-0.96, and abstract "implements or
 * defines" wording under-rated task-shaped goals; this one separated the true
 * windows (0.8+) from same-file noise (below 0.45).
 */
export const WINDOW_RELEVANCE = {
  instruction:
    "Would someone carrying out `context.goal` need to read or change the code or text in the candidate? " +
    "Unrelated code that merely sits in the same file does not count.",
  criteria: {
    true: "The candidate contains code or text that the goal directly involves.",
    false: "The candidate is unrelated to the goal, even if it is in the same file.",
  },
};

/** Indices of the best candidates at or above `threshold`, best first, at most `max`. */
export function topIndices(ratings, { threshold = 0.5, max = 3 } = {}) {
  return ratings
    .map((probability, index) => ({ probability, index }))
    .filter((entry) => entry.probability !== null && entry.probability >= threshold)
    .sort((a, b) => b.probability - a.probability || b.index - a.index)
    .slice(0, max)
    .map((entry) => entry.index);
}
