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
import { estimateTokens, messageText, segmentMessages, splitSpans } from "./segment.mjs";

const MAX_SEGMENTS = 400;
const VERBATIM_MAX = 4000;
const EXCERPT_MAX = 300;
const PREVIOUS_MAX = 6000;
/** A handoff this close to the transcript it replaces frees nothing. */
const MAX_SIZE_RATIO = 0.6;
/**
 * What a handoff aims for. Over it, the least load-bearing entries are cut
 * down until it fits; only pinned content (user constraints, open problems,
 * entries verification forced verbatim) can push it past, up to MAX_SIZE_RATIO.
 */
const TARGET_RATIO = 0.25;
const MAX_HANDOFF_TOKENS = 12000;
/** Faithful is judged as "did the entry misstate the source"; ambiguous scores keep the excerpt. */
const FAITHFUL_FAILS_BELOW = 0.35;

const KEEP_BELOW = 0.4; // hard-rule thresholds sit low: a false keep is cheap, a false drop is not

export function decideTrigger({ percent, soft, hard, moment }) {
  if (percent === null || percent === undefined || percent < soft) return "none";
  if (percent >= hard || moment?.clean) return "compact";
  return "wait";
}

/**
 * Content the hard rules keep verbatim whatever the budget. Role-scoped:
 * constraints come from the user, and file contents are not an error report
 * even when they mention a bug.
 */
function hardKeep(scores, segment) {
  if (!scores) return false;
  const constraint = segment.role === "user" && (scores.user_constraint ?? 0) >= KEEP_BELOW;
  const problem = segment.tool !== "read" && (scores.unresolved ?? 0) >= KEEP_BELOW;
  return constraint || problem;
}

/** Tool output that names where it came from, so a pointer can stand in for it. */
function recoverableSource(scores, segment) {
  return (
    segment.role === "toolResult" &&
    (scores?.recoverable ?? 0) >= 0.6 &&
    Boolean(segment.path || segment.command)
  );
}

/** Route one segment. `null` scores mean scoring failed, which keeps it. */
export function classify(scores, segment) {
  if (!scores || hardKeep(scores, segment)) return "keep_verbatim";
  let disposition = Object.hasOwn(DISPOSITIONS, scores.disposition)
    ? scores.disposition
    : "keep_verbatim";
  // Tool output was over half of every measured handoff, and it can be re-run
  // or re-read. Verbatim is for what cannot: an error the agent has not fixed,
  // which hardKeep already pinned when it is still open.
  if (disposition === "keep_verbatim" && segment.role === "toolResult" && !segment.isError) {
    disposition = "excerpt";
  }
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

/** Derived selections are computed once per segment and reused when the handoff is rebuilt. */
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
async function buildEntries({ segments, scores, forced, pointed = new Set(), select }) {
  const entries = [];
  await mapPool(segments, async (segment, index) => {
    const s = scores[index];
    // Pinned: what the budget may never cut. User constraints are few and
    // cheap. Open problems are not pinned: the judge sees one segment ahead,
    // so a fix a few turns later is invisible and it flagged 29% of a measured
    // span. They stay verbatim when there is room and are cut last.
    const constraint = segment.role === "user" && (s?.user_constraint ?? 0) >= KEEP_BELOW;
    const pinned = forced.has(segment.id) || constraint;
    const disposition = pinned
      ? "keep_verbatim"
      : pointed.has(segment.id)
        ? "point"
        : classify(s, segment);
    const open = hardKeep(s, segment) ? 1 : 0;
    // Unscored segments weigh the most: not knowing is no reason to cut first.
    const base = { segment, disposition, index, pinned, weight: open + (s?.load_bearing ?? 1) };
    if (disposition === "drop") return;
    if (disposition === "keep_verbatim") {
      const text = excerpt(segment.text, VERBATIM_MAX);
      const section = constraint ? "constraints" : "context";
      entries.push({ ...base, section, text, lossy: text !== segment.text });
    } else if (disposition === "point" && !segment.path) {
      // Command output: name the command, never tell the reader to re-run it
      // blindly, since a command that wrote or deployed must not run twice.
      const text = `$ ${excerpt(segment.command, 200)} (output not kept; re-run only if safe)`;
      entries.push({ ...base, section: "pointers", text, lossy: false });
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

const handoffTokens = (entry) => estimateTokens(entry.text) + 1;

/**
 * Cut unpinned entries down until they fit `budget` tokens, least
 * load-bearing first: verbatim copies become excerpts, then plain context
 * excerpts are dropped. Decisions and pointers are small and stay. Pinned
 * entries are never touched, so the result can still exceed the budget.
 */
export function fitBudget(entries, budget) {
  let total = entries.reduce((sum, e) => sum + handoffTokens(e), 0);
  if (total <= budget) return entries;
  const out = [...entries];
  const order = out
    .map((entry, at) => ({ entry, at }))
    .filter(({ entry }) => !entry.pinned)
    .sort(
      (a, b) => a.entry.weight - b.entry.weight || handoffTokens(b.entry) - handoffTokens(a.entry),
    );
  for (const { entry, at } of order) {
    if (total <= budget) break;
    if (entry.disposition !== "keep_verbatim") continue;
    const text = `[${label(entry.segment)}] ${excerpt(entry.segment.text, EXCERPT_MAX)}`;
    const shorter = { ...entry, disposition: "excerpt", section: "context", text, lossy: true };
    total += handoffTokens(shorter) - handoffTokens(entry);
    out[at] = shorter;
  }
  const dropped = new Set();
  for (const { at } of order) {
    if (total <= budget) break;
    if (out[at].section !== "context") continue;
    total -= handoffTokens(out[at]);
    dropped.add(at);
  }
  return out.filter((_, at) => !dropped.has(at));
}

/**
 * Wrap `ask` so an identical request is answered once. Old messages do not
 * change between turns, so a retry after a rejection, or the next compaction
 * over an overlapping span, pays only for what is new. Failures are not kept.
 */
export function memoizeAsk(ask, max = 2000) {
  const memo = new Map();
  return async ({ signal, ...request }) => {
    const key = JSON.stringify(request);
    if (memo.has(key)) return memo.get(key);
    const answer = await ask({ ...request, signal });
    memo.set(key, answer);
    if (memo.size > max) memo.delete(memo.keys().next().value);
    return answer;
  };
}

const bullets = (items) => items.map((text) => `- ${text.replace(/\n/g, "\n  ")}`).join("\n");

/**
 * The way back, in the handoff's own voice. A handoff is a note plus a way to
 * check it: measured on cross-session capsules, one search of the transcript a
 * capsule replaced was worth 20-33 points of recall — more than any wording of
 * the note. This is a fixed line the model never writes.
 */
function wayBack(restore) {
  if (!restore?.path) return "";
  const entries = Number(restore.entries) || 0;
  return (
    `The conversation this replaced is on disk, verbatim: \`${restore.path}\` (${entries} entries, ` +
    "one JSON object per line, oldest first). Search it before guessing at anything not stated above: " +
    `\`rg -n '<term>' ${restore.path}\`.`
  );
}

function renderHandoff({ goal, entries, fileLists, previousSummary, note, restore }) {
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
    ["Full transcript (searchable)", wayBack(restore)],
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
  restore,
  tokensBefore,
  ask = askSystemOne,
  signal,
  onRejected,
}) {
  const reject = (reason) => {
    onRejected?.(reason);
    return null;
  };
  const segments = segmentMessages(messages);
  if (segments.length === 0) return reject("no text to summarize");
  if (segments.length > MAX_SEGMENTS) {
    return reject(`${segments.length} segments exceeds the ${MAX_SEGMENTS}-segment limit`);
  }

  const goal = await pickGoal({
    userSegments: segments.filter((s) => s.role === "user"),
    ask,
    signal,
  });
  const scores = await scoreSegments({ segments, goal, ask, signal });
  const select = selector({ goal, ask, signal });
  // The first user message states the task the session exists for, and pi
  // replaces everything before the cut with this one handoff: nothing else can
  // carry it. Pin it verbatim whatever Jev scored, as constraints are.
  const task = segments.find((segment) => segment.role === "user");
  // Seeds the same set verification adds to, so the budget and the coverage
  // check treat it as pinned; excluded from the reported count below, which
  // measures what verification forced.
  const taskPin = task ? 1 : 0;
  const forced = new Set(task ? [task.id] : []);

  // One verification pass, then a rebuild with every flagged segment verbatim.
  // Checking again would re-ask questions already answered: forced segments
  // have left the checked set, every other entry is unchanged, and the rebuilt
  // handoff only grows — so a re-ask can only flip a settled answer into
  // forcing yet another segment, never uncover a gap the first pass missed.
  // The entries' share of the target: the fixed sections cost what they cost.
  const overhead = estimateTokens(
    renderHandoff({ goal, entries: [], fileLists, previousSummary, note, restore }),
  );
  const budget = Math.min(tokensBefore * TARGET_RATIO, MAX_HANDOFF_TOKENS) - overhead;
  // Fitting comes before verification, so what is verified is what ships.
  let entries = fitBudget(await buildEntries({ segments, scores, forced, select }), budget);
  let summary = renderHandoff({ goal, entries, fileLists, previousSummary, note, restore });

  // Faithfulness is judged on entries that restate their source. A verbatim
  // copy cannot misstate it — even a capped one — and coverage decides
  // whether what was kept is enough.
  const restated = entries.filter((e) => e.lossy && e.disposition !== "keep_verbatim");
  const important = segments.filter(
    (segment, index) =>
      !forced.has(segment.id) &&
      !entries.some((e) => e.index === index && e.disposition === "keep_verbatim" && !e.lossy) &&
      ((scores[index]?.load_bearing ?? 0) >= 0.6 || (scores[index]?.decision ?? 0) >= 0.5),
  );
  const [faithful, covered] = await Promise.all([
    verifyEntries({
      entries: restated.map((e) => ({ entry: e.text, source: e.segment.text })),
      ask,
      signal,
    }),
    verifyCoverage({ handoff: summary, segments: important, ask, signal }),
  ]);

  // Only a definite "no" blocks; an unusable answer is not evidence of a gap.
  const failed = new Set([
    ...restated
      .filter((_, i) => faithful[i] !== null && faithful[i] < FAITHFUL_FAILS_BELOW)
      .map((e) => e.segment.id),
    ...important.filter((_, i) => covered[i] !== null && covered[i] < 0.5).map((s) => s.id),
  ]);
  // A flagged entry comes back verbatim, unless it is tool output that can be
  // re-read or re-run: then a pointer covers it at a fraction of the size.
  // Forced copies were most of what pushed measured handoffs past the target.
  const pointed = new Set();
  segments.forEach((segment, index) => {
    if (!failed.has(segment.id)) return;
    if (recoverableSource(scores[index], segment)) pointed.add(segment.id);
    else forced.add(segment.id);
  });
  if (failed.size > 0) {
    entries = fitBudget(await buildEntries({ segments, scores, forced, pointed, select }), budget);
    summary = renderHandoff({ goal, entries, fileLists, previousSummary, note, restore });
  }

  const summaryTokens = estimateTokens(summary);
  if (summaryTokens >= tokensBefore * MAX_SIZE_RATIO) {
    return reject(
      `handoff estimates ${summaryTokens} tokens; must be below ${Math.ceil(tokensBefore * MAX_SIZE_RATIO)} ` +
        `(60% of ${tokensBefore} replaced tokens)`,
    );
  }
  return {
    summary,
    details: {
      safeCompact: {
        segments: segments.length,
        // One verification pass, plus the rebuild when it forced anything.
        rounds: failed.size > 0 ? 2 : 1,
        kept: entries.length,
        forced: forced.size - taskPin,
        pointed: pointed.size,
        pinned: entries.filter((e) => e.pinned).length,
        // Where the handoff's tokens went, so a bloated one can be diagnosed.
        tokens: entries.reduce((by, e) => {
          by[e.segment.role] = (by[e.segment.role] ?? 0) + estimateTokens(e.text);
          return by;
        }, {}),
      },
      note: note ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Inline boundary compaction (the `turn_end` path)
//
// pi computes the native cut itself and hands it over as `preparation`; for an
// inline `turn_end` compaction there is no preparation, so this ports pi's
// projected cut-point rules. Only entries a provider can start from are valid
// cuts, which is what keeps tool results with the tool call that produced them.

const DEFAULT_KEEP_RECENT = 20000;
const MIN_SUMMARIZED_RATIO = 0.25;
const MIN_SUMMARIZED_TOKENS = 2000;

const CUT_ROLES = new Set([
  "user",
  "assistant",
  "bashExecution",
  "custom",
  "branchSummary",
  "compactionSummary",
]);

const estimateMessageTokens = (message) => estimateTokens(messageText(message));

const entryTokens = (entry) =>
  (entry?.messages ?? []).reduce((sum, message) => sum + estimateMessageTokens(message), 0);

/** The segments a handoff would carry for `entries[startIndex, cutIndex)`. */
const summarizableMessages = (entries, startIndex, cutIndex) => {
  let count = 0;
  for (let i = startIndex; i < cutIndex; i++) {
    if (entries[i]?.sourceEntry?.type === "compaction") continue;
    for (const message of entries[i]?.messages ?? []) {
      if (message?.role !== "system" && messageText(message).trim()) count++;
    }
  }
  return count;
};

const isCutEntry = (entry) =>
  entry?.sourceEntry?.type !== "compaction" &&
  (entry?.messages ?? []).some((message) => CUT_ROLES.has(message?.role));

/** File lists from either pi's `CompactionDetails` or this extension's details. */
export function fileListsFromDetails(details) {
  const strings = (value) =>
    Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
  return { readFiles: strings(details?.readFiles), modifiedFiles: strings(details?.modifiedFiles) };
}

/** Union file lists, dropping files that were also modified. */
export function mergeFileLists(...lists) {
  const read = new Set();
  const modified = new Set();
  for (const list of lists) {
    for (const file of list?.readFiles ?? []) read.add(file);
    for (const file of list?.modifiedFiles ?? []) modified.add(file);
  }
  return {
    readFiles: [...read].filter((file) => !modified.has(file)).sort(),
    modifiedFiles: [...modified].sort(),
  };
}

const addFileOp = (tool, args, ops) => {
  const path = typeof args?.path === "string" ? args.path : undefined;
  if (!path) return;
  if (tool === "read") ops.read.add(path);
  else if (tool === "write") ops.written.add(path);
  else if (tool === "edit") ops.edited.add(path);
};

/** Mirror pi's file tracking so pointers survive repeated compactions. */
const fileOpsFromMessages = (messages) => {
  const ops = { read: new Set(), written: new Set(), edited: new Set() };
  for (const message of messages ?? []) {
    if (message?.role === "toolResult") {
      for (const call of message.nestedCalls?.calls ?? [])
        addFileOp(call?.name, call?.arguments, ops);
      continue;
    }
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type === "toolCall") addFileOp(block.name, block.arguments, ops);
    }
  }
  const modified = new Set([...ops.edited, ...ops.written]);
  return {
    readFiles: [...ops.read].filter((file) => !modified.has(file)).sort(),
    modifiedFiles: [...modified].sort(),
  };
};

/**
 * Choose the cut for an inline compaction from the live projection: keep the
 * recent span and summarize everything before it. Returns null when there is
 * nothing meaningful to compact, so the caller keeps the native fallback.
 * `entries` are `ProjectedSessionEntry` values from the turn_end boundary, so
 * their `sourceEntry.id` values are real branch entry ids.
 */
export function planBoundary({ entries, keepRecentTokens = DEFAULT_KEEP_RECENT } = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const messageTokens = entries.reduce((sum, entry) => sum + entryTokens(entry), 0);
  if (messageTokens < MIN_SUMMARIZED_TOKENS) return null;
  // Always summarize something meaningful, even when the configured recent
  // span would swallow the whole (small) context.
  const floor = Math.max(MIN_SUMMARIZED_TOKENS, messageTokens * MIN_SUMMARIZED_RATIO);
  const budget = Math.max(0, Math.min(keepRecentTokens, messageTokens - floor));

  const previousIndex = entries.findIndex(
    (entry) => entry?.sourceEntry?.type === "compaction" && (entry?.messages?.length ?? 0) > 0,
  );
  const previous = previousIndex >= 0 ? entries[previousIndex].sourceEntry : null;
  const startIndex = previousIndex + 1;

  const cutPoints = [];
  for (let i = startIndex; i < entries.length; i++) if (isCutEntry(entries[i])) cutPoints.push(i);
  if (cutPoints.length === 0) return null;

  let accumulated = 0;
  let exceeded = false;
  let cutIndex = cutPoints[0];
  for (let i = entries.length - 1; i >= startIndex; i--) {
    const tokens = entryTokens(entries[i]);
    if (tokens === 0) continue;
    accumulated += tokens;
    if (accumulated >= budget) {
      exceeded = true;
      cutIndex = cutPoints.find((candidate) => candidate >= i) ?? cutPoints[cutPoints.length - 1];
      break;
    }
  }
  if (!exceeded) return null;

  // Context-invisible entries do not move the cut; a previous compaction does.
  while (cutIndex > startIndex) {
    const before = entries[cutIndex - 1];
    if (before?.sourceEntry?.type === "compaction" || (before?.messages?.length ?? 0) > 0) break;
    cutIndex--;
  }

  // One handoff cannot verify unbounded input: cap the summarized span and let
  // the next boundary compact the rest. Without this, any session that grows
  // past the cap could never compact at all.
  while (
    cutIndex > startIndex &&
    summarizableMessages(entries, startIndex, cutIndex) > MAX_SEGMENTS
  ) {
    const earlier = cutPoints.findLast((point) => point < cutIndex);
    if (earlier === undefined) return null;
    cutIndex = earlier;
  }

  const summarized = entries.slice(startIndex, cutIndex);
  const summarizedTokens = summarized.reduce((sum, entry) => sum + entryTokens(entry), 0);
  // A trailing span (often huge tool results) can push the cut late enough
  // that the summarized range is trivial. Refuse to ship that: it frees
  // nothing while adding a checkpoint and a summary to the context.
  if (summarizedTokens < MIN_SUMMARIZED_TOKENS) return null;

  const messages = summarized
    .filter((entry) => entry?.sourceEntry?.type !== "compaction")
    .flatMap((entry) => (entry?.messages ?? []).filter((message) => message?.role !== "system"));
  const firstKeptEntryId = entries[cutIndex]?.sourceEntry?.id;
  if (messages.length === 0 || typeof firstKeptEntryId !== "string") return null;

  return {
    firstKeptEntryId,
    messages,
    previousSummary: typeof previous?.summary === "string" ? previous.summary : undefined,
    fileLists: mergeFileLists(
      fileListsFromDetails(previous?.details),
      fileOpsFromMessages(messages),
    ),
    summarizedTokens,
  };
}

/**
 * Compose the inline handoff for a turn_end boundary. Returns the draft payload
 * (without `type`) or null when there is nothing worth compacting or the
 * handoff cannot be verified. The caller keeps the context either way and can
 * tell the two apart with `planBoundary` before warning.
 */
export async function buildBoundaryCompaction({
  entries,
  keepRecentTokens,
  note,
  restore,
  ask,
  signal,
  onRejected,
}) {
  const plan = planBoundary({ entries, keepRecentTokens });
  if (!plan) return null;
  const result = await composeHandoff({
    messages: plan.messages,
    previousSummary: plan.previousSummary,
    fileLists: plan.fileLists,
    note,
    restore,
    // The new handoff replaces both the old summary and this message span.
    tokensBefore: plan.summarizedTokens + estimateTokens(plan.previousSummary ?? ""),
    ask,
    signal,
    onRejected,
  });
  if (!result) return null;
  return {
    firstKeptEntryId: plan.firstKeptEntryId,
    summary: result.summary,
    details: {
      ...result.details,
      readFiles: plan.fileLists.readFiles,
      modifiedFiles: plan.fileLists.modifiedFiles,
    },
  };
}
