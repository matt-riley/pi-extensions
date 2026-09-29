// plan.mjs — classify, select, assemble and verify the handoff.
//
// Code owns the policy: hard rules beat model scores, and uncertainty keeps
// content rather than dropping it. Jev supplies the judgments (judge.mjs);
// every line of the handoff is copied from a real segment or file window.

import { askSystemOne } from "../../shared/systemone.mjs";
import {
  excerpt,
  mapPool,
  rateCandidates,
  splitWindows,
  topIndices,
  WINDOW_RELEVANCE,
} from "../../shared/spans.mjs";
import { DISPOSITIONS, judgeSegment, pickGoal, verifyCoverage, verifyEntries } from "./judge.mjs";
import { estimateTokens, segmentMessages, splitSpans } from "./segment.mjs";

const MAX_ROUNDS = 3;
const MAX_SEGMENTS = 400;
const VERBATIM_MAX = 4000;
const EXCERPT_MAX = 300;
const PREVIOUS_MAX = 6000;
/** A handoff this close to the transcript it replaces frees nothing. */
const MAX_SIZE_RATIO = 0.6;

const KEEP_BELOW = 0.4; // hard-rule thresholds sit low: a false keep is cheap, a false drop is not

export function decideTrigger({ percent, soft, hard, moment }) {
  if (percent === null || percent === undefined || percent < soft) return "none";
  if (percent >= hard || moment?.clean) return "compact";
  return "wait";
}

/** Route one segment. `null` scores mean scoring failed, which keeps it. */
export function classify(scores, segment) {
  if (!scores) return "keep_verbatim";
  // Role-scoped: constraints come from the user, and file contents are not an
  // error report even when they mention a bug.
  const constraint = segment.role === "user" && (scores.user_constraint ?? 0) >= KEEP_BELOW;
  const problem = segment.tool !== "read" && (scores.unresolved ?? 0) >= KEEP_BELOW;
  if (constraint || problem) return "keep_verbatim";
  let disposition = Object.hasOwn(DISPOSITIONS, scores.disposition)
    ? scores.disposition
    : "keep_verbatim";
  // Uncertain or load-bearing content is never dropped outright.
  if (
    disposition === "drop" &&
    ((scores.confidence ?? 0) < 0.5 || (scores.load_bearing ?? 1) >= 0.5)
  ) {
    disposition = "excerpt";
  }
  if (
    disposition !== "keep_verbatim" &&
    (scores.recoverable ?? 0) >= 0.6 &&
    segment.tool === "read" &&
    segment.path
  ) {
    disposition = "point";
  }
  if (disposition === "point" && !segment.path) disposition = "excerpt";
  return disposition;
}

const label = (segment) => (segment.tool ? `${segment.role}:${segment.tool}` : segment.role);

function firstLine(text) {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return excerpt(line.trim(), 80);
}

/** Score every segment; if every call failed, surface the error so the caller falls back. */
async function scoreSegments({ segments, goal, ask, signal }) {
  let firstError;
  const scores = await mapPool(segments, async (segment, index) => {
    try {
      return await judgeSegment({ goal, segment, next: segments[index + 1], ask, signal });
    } catch (error) {
      firstError ??= error;
      return null;
    }
  });
  if (firstError && scores.every((s) => s === null)) throw firstError;
  return scores;
}

/** Derived selections are computed once per segment and reused across verification rounds. */
function selector({ goal, ask, signal }) {
  const memo = new Map();
  const once = (key, compute) => {
    if (!memo.has(key)) memo.set(key, compute());
    return memo.get(key);
  };
  return {
    decisionSpans: (segment) =>
      once(`d${segment.id}`, async () => {
        const spans = splitSpans(segment.text);
        const ratings = await rateCandidates({
          context: goal,
          candidates: spans,
          instruction: "Does the candidate state the decision that was made, or the reason for it?",
          ask,
          signal,
        });
        return topIndices(ratings, { threshold: 0.5, max: 3 })
          .sort((a, b) => a - b)
          .map((index) => spans[index]);
      }),
    fileWindows: (segment) =>
      once(`w${segment.id}`, async () => {
        const windows = splitWindows(segment.text);
        const ratings = await rateCandidates({
          context: { goal, file: segment.path },
          candidates: windows.map((w) => w.text),
          ...WINDOW_RELEVANCE,
          ask,
          signal,
        });
        return topIndices(ratings, { threshold: 0.5, max: 2 })
          .sort((a, b) => a - b)
          .map((index) => windows[index]);
      }),
  };
}

/** Build the entries for one round. `forced` segments are pinned to verbatim. */
async function buildEntries({ segments, scores, forced, select }) {
  const entries = [];
  await mapPool(segments, async (segment, index) => {
    const s = scores[index];
    const disposition = forced.has(segment.id) ? "keep_verbatim" : classify(s, segment);
    const base = { segment, disposition, index };
    if (disposition === "drop") return;
    if (disposition === "keep_verbatim") {
      const text = excerpt(segment.text, VERBATIM_MAX);
      const section =
        segment.role === "user" && (s?.user_constraint ?? 0) >= KEEP_BELOW
          ? "constraints"
          : "context";
      entries.push({ ...base, section, text, lossy: text !== segment.text });
    } else if (disposition === "point") {
      const windows = await select.fileWindows(segment);
      const lines =
        windows.length === 0
          ? [`${segment.path}`]
          : windows.map((w) => {
              const from = segment.offset + w.start - 1;
              const to = segment.offset + w.end - 1;
              return `${segment.path}:${from}-${to} (starts: "${firstLine(w.text)}")`;
            });
      entries.push({ ...base, section: "pointers", text: lines.join("\n"), lossy: false });
    } else if ((s?.decision ?? 0) >= 0.5 && segment.role !== "toolResult") {
      const spans = await select.decisionSpans(segment);
      const text = spans.length > 0 ? spans.join(" ") : excerpt(segment.text, EXCERPT_MAX);
      entries.push({
        ...base,
        section: "decisions",
        text: `[${label(segment)}] ${text}`,
        lossy: true,
      });
    } else {
      const text = `[${label(segment)}] ${excerpt(segment.text, EXCERPT_MAX)}`;
      entries.push({ ...base, section: "context", text, lossy: segment.text.length > EXCERPT_MAX });
    }
  });
  return entries.sort((a, b) => a.index - b.index);
}

const bullets = (items) => items.map((text) => `- ${text.replace(/\n/g, "\n  ")}`).join("\n");

function renderHandoff({ goal, entries, fileLists, previousSummary, note }) {
  const bySection = (name) => entries.filter((e) => e.section === name).map((e) => e.text);
  const files = [
    fileLists.readFiles.length ? `read: ${fileLists.readFiles.join(", ")}` : "",
    fileLists.modifiedFiles.length ? `modified: ${fileLists.modifiedFiles.join(", ")}` : "",
  ].filter(Boolean);
  const pointers = [...bySection("pointers"), ...files];
  const sections = [
    ["Goal", goal],
    ["Constraints & preferences (verbatim)", bullets(bySection("constraints"))],
    ["Key decisions", bullets(bySection("decisions"))],
    ["Context carried forward", bullets(bySection("context"))],
    ["Pointers (re-read on demand)", bullets(pointers)],
    ["Earlier context", previousSummary ? excerpt(previousSummary, PREVIOUS_MAX) : ""],
    ["Agent note (verbatim)", note ?? ""],
  ];
  return sections
    .filter(([, body]) => body.trim())
    .map(([title, body]) => `## ${title}\n${body}`)
    .join("\n\n");
}

/**
 * Compose a verified handoff, or return null when it cannot be verified or is
 * not smaller than what it replaces — the caller then falls back to pi's own
 * compaction. Throws only when Jev is unreachable for every call.
 */
export async function composeHandoff({
  messages,
  previousSummary,
  fileLists = { readFiles: [], modifiedFiles: [] },
  note,
  tokensBefore,
  ask = askSystemOne,
  signal,
}) {
  const segments = segmentMessages(messages);
  if (segments.length === 0 || segments.length > MAX_SEGMENTS) return null;

  const goal = await pickGoal({
    userSegments: segments.filter((s) => s.role === "user"),
    ask,
    signal,
  });
  const scores = await scoreSegments({ segments, goal, ask, signal });
  const select = selector({ goal, ask, signal });
  const forced = new Set();

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const entries = await buildEntries({ segments, scores, forced, select });
    const summary = renderHandoff({ goal, entries, fileLists, previousSummary, note });

    const lossy = entries.filter((e) => e.lossy);
    const important = segments.filter(
      (segment, index) =>
        !forced.has(segment.id) &&
        !entries.some((e) => e.index === index && e.disposition === "keep_verbatim" && !e.lossy) &&
        ((scores[index]?.load_bearing ?? 0) >= 0.6 || (scores[index]?.decision ?? 0) >= 0.5),
    );
    const [faithful, covered] = await Promise.all([
      verifyEntries({
        entries: lossy.map((e) => ({ entry: e.text, source: e.segment.text })),
        ask,
        signal,
      }),
      verifyCoverage({ handoff: summary, segments: important, ask, signal }),
    ]);

    // Only a definite "no" blocks; an unusable answer is not evidence of a gap.
    const failed = new Set([
      ...lossy.filter((_, i) => faithful[i] !== null && faithful[i] < 0.5).map((e) => e.segment.id),
      ...important.filter((_, i) => covered[i] !== null && covered[i] < 0.5).map((s) => s.id),
    ]);
    const stats = {
      segments: segments.length,
      rounds: round,
      kept: entries.length,
      forced: forced.size,
    };
    if (failed.size === 0) {
      if (estimateTokens(summary) >= tokensBefore * MAX_SIZE_RATIO) return null;
      return { summary, details: { safeCompact: stats, note: note ?? null } };
    }
    const fresh = [...failed].filter((id) => !forced.has(id));
    if (fresh.length === 0) return null; // verbatim already and still flagged: give up safely
    for (const id of fresh) forced.add(id);
  }
  return null;
}
