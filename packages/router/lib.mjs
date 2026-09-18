// lib.mjs — the pure half of the routing harness.
//
// No I/O, no network, no model: turn features, ground truth, the gate, and the
// scoring arithmetic. The point of the harness is to answer two questions with
// real sessions as the answer key:
//
//   1. Which tool groups can actually be predicted, and which are so common
//      that predicting them is not worth the risk of getting them wrong?
//   2. Does a routing gate catch the turns that shifted while staying quiet on
//      the ones that merely continued?
//
// Ground truth is what a turn *used*: the groups whose tools appear in it. That
// is the operational question for scoping — if a turn used bash, the turn
// needed bash active — so it is the right label even though it cannot say
// whether the model chose well.

/** Tool groups, by the real tool names seen in this repo's sessions. */
export const TOOL_GROUPS = {
  read: [
    "read",
    "grep",
    "ls",
    "find",
    "code_search",
    "file_outline",
    "find_definition",
    "repo_map",
  ],
  edit: ["edit", "write"],
  shell: ["bash", "shell"],
  web: ["web_fetch", "batch_web_fetch", "web_search", "plan_fetch_url"],
  memory: [
    "lore_recall",
    "lore_retain",
    "lore_save",
    "lore_search",
    "lore_status",
    "lore_forget",
    "lore_explain",
    "lore_onboard",
  ],
  plan: ["plan_mode_question", "plan_mode_complete"],
  agents: ["subagent", "traycer_create_agent"],
  skill: ["skill_select"],
  judge: ["typesafe_ask"],
};

const NAME_TO_GROUP = new Map();
for (const [group, names] of Object.entries(TOOL_GROUPS)) {
  for (const name of names) NAME_TO_GROUP.set(name, group);
}

/** Which group a tool belongs to, or "other" for anything unmapped. */
export function groupOf(toolName) {
  return NAME_TO_GROUP.get(String(toolName ?? "").toLowerCase()) ?? "other";
}

/**
 * The groups a turn used, plus any unmapped tool names.
 *
 * `other` is reported separately rather than silently folded into a group: an
 * unmapped tool means the config is out of date, which the harness should say
 * out loud instead of quietly mis-scoring.
 */
export function groupsUsed(toolCalls) {
  const groups = new Set();
  const unmapped = new Set();
  for (const call of toolCalls ?? []) {
    const name = String(call?.name ?? "").toLowerCase();
    const group = groupOf(name);
    if (group === "other") unmapped.add(name);
    else groups.add(group);
  }
  return { groups, unmapped };
}

/** Everything the harness needs to know about one turn, from the transcript. */
export function groundTruth(turn) {
  const { groups, unmapped } = groupsUsed(turn?.toolCalls);
  const toolCount = (turn?.toolCalls ?? []).length;
  return {
    groups,
    unmapped,
    toolCount,
    isConversational: toolCount === 0,
    usedShell: groups.has("shell"),
    usedEdit: groups.has("edit"),
    usedRead: groups.has("read"),
    usedWeb: groups.has("web"),
    failedCalls: (turn?.toolCalls ?? []).filter((call) => call?.isError).length,
  };
}

/**
 * Whether the turn *needed* a configuration the previous turn did not have.
 *
 * This is the answer key for the gate. A turn that uses a group its
 * predecessor did not is a shift, because the configuration that was correct
 * for the previous turn would have been short a tool here.
 */
export function shouldRoute(previousTurn, turn) {
  const now = groupsUsed(turn?.toolCalls).groups;
  if (!previousTurn) return { route: true, reason: "first turn", added: [...now] };
  const before = groupsUsed(previousTurn.toolCalls).groups;
  const added = [...now].filter((group) => !before.has(group));
  if (added.length) return { route: true, reason: `new group(s): ${added.join(", ")}`, added };
  return { route: false, reason: "groups are a subset of the previous turn's", added: [] };
}

/**
 * Whether a "user" turn was typed or injected.
 *
 * The transcripts do not record a source, but two shapes give it away: messages
 * pushed in by another agent integration, and context dumps that begin with a
 * markdown heading. Both are turns the agent handled, so they count for usage
 * — but they are not prompts a router can classify, so they are excluded from
 * prompt-quality scoring and reported instead of quietly dropped.
 */
export function looksInjected(prompt) {
  const text = String(prompt ?? "").trim();
  if (text.startsWith("[traycer:")) return "agent message";
  if (text.startsWith("# ")) return "context dump";
  return null;
}

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "if",
  "then",
  "than",
  "that",
  "this",
  "these",
  "those",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "am",
  "do",
  "does",
  "did",
  "doing",
  "done",
  "it",
  "its",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by",
  "for",
  "with",
  "from",
  "as",
  "so",
  "not",
  "you",
  "your",
  "we",
  "our",
  "i",
  "me",
  "my",
  "he",
  "she",
  "they",
  "them",
  "his",
  "her",
  "can",
  "could",
  "should",
  "would",
  "will",
  "just",
  "now",
  "also",
  "up",
  "out",
  "about",
  "please",
  "thanks",
  "yes",
  "no",
  "ok",
  "okay",
  "sure",
  "go",
  "get",
  "let",
  "make",
  "use",
]);

/** Content words, lowercased, for cheap topic-overlap between prompts. */
export function contentWords(text) {
  return new Set(
    String(text ?? "")
      .toLowerCase()
      .split(/[^a-z0-9_./-]+/)
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word)),
  );
}

export function overlapRatio(a, b) {
  const left = a instanceof Set ? a : contentWords(a);
  const right = b instanceof Set ? b : contentWords(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / Math.min(left.size, right.size);
}

/**
 * The routing gate: route on a shift, stay put on a continuation.
 *
 * Deliberately cheap and dumb, because its job is not to be clever — it is to
 * keep the judged call off the common case. Its accuracy is measured against
 * `shouldRoute` on real turns, so "dumb" here is a testable claim rather than
 * an excuse.
 */
export function gateTurn({ prompt, previousTurn } = {}) {
  const words = contentWords(prompt);
  if (!previousTurn) return { route: true, reason: "first turn", signals: { words: words.size } };
  const previousWords = contentWords(previousTurn.prompt);
  const overlap = overlapRatio(words, previousWords);
  const length = String(prompt ?? "").trim().length;
  const signals = { words: words.size, overlap, length };

  // A long prompt is usually a new task description, not a follow-up.
  if (length >= 200) return { route: true, reason: "long prompt", signals };
  // No vocabulary in common with the previous prompt: a different subject.
  if (words.size >= 3 && overlap < 0.2) return { route: true, reason: "topic shift", signals };
  return { route: false, reason: "looks like a continuation", signals };
}

/**
 * Groups used so often that offering them always beats predicting them.
 *
 * Measured over 810 typed turns: shell 78%, edit 43%, read 38%. A prediction
 * that misses one of these hands the turn a toolset it cannot work with, and
 * the saving is a handful of schema tokens.
 */
export const ALWAYS_ON_GROUPS = ["read", "edit", "shell"];

/**
 * Groups only some turns need. These are the ones worth scoping, because the
 * saving is the same per tool removed while the risk is bounded by how rarely
 * the group is wanted — and by the escape hatch, which can widen mid-turn.
 */
export const SCOPED_GROUPS = ["web", "memory", "plan", "agents", "skill", "judge"];

/**
 * Whether a turn's groups would all have been available.
 *
 * This is the metric that matters, and it is weaker than precision/recall on
 * purpose: a turn does not care that a tool was offered *because it was
 * predicted* — only that it was offered.
 */
export function coveredBy(row, offered) {
  const missing = [...(row.truthGroups ?? [])].filter((group) => !offered.has(group));
  return { covered: missing.length === 0, missing };
}

/**
 * Coverage under the recommended policy: always-on groups, plus whatever the
 * judge predicted for this turn. Reported per group so a scoped group that is
 * routinely missed shows up as work for the escape hatch rather than as a
 * silent failure.
 */
export function coverageReport(rows) {
  const alwaysOn = new Set(ALWAYS_ON_GROUPS);
  let covered = 0;
  const missingByGroup = {};
  for (const row of rows) {
    const offered = new Set(alwaysOn);
    for (const group of row.predictedGroups ?? []) offered.add(group);
    const { covered: ok, missing } = coveredBy(row, offered);
    if (ok) covered++;
    for (const group of missing) missingByGroup[group] = (missingByGroup[group] ?? 0) + 1;
  }
  return {
    turns: rows.length,
    covered,
    rate: rows.length ? covered / rows.length : 1,
    missingByGroup,
  };
}

/**
 * Precision/recall for one boolean prediction.
 *
 * Reported rather than judged: a recall of 0.6 on a group used by 2% of turns
 * is a smaller problem than the same recall on one used by 90%, which is why
 * the harness prints usage rate next to every score.
 *
 * @param {{truth: boolean, predicted: boolean}[]} observations
 */
export function scoreBinary(observations) {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const row of observations) {
    if (row.truth && row.predicted) tp++;
    else if (row.truth) fn++;
    else if (row.predicted) fp++;
    else tn++;
  }
  const precision = tp + fp ? tp / (tp + fp) : null;
  const recall = tp + fn ? tp / (tp + fn) : null;
  return { tp, fp, fn, tn, precision, recall, positives: tp + fn, total: observations.length };
}

/** How often each group appears, over every turn — the case for scoping it. */
function groupUsage(rows) {
  const usage = {};
  const total = rows.length || 1;
  for (const group of [...Object.keys(TOOL_GROUPS), "other"]) {
    usage[group] = rows.filter((row) => row.truthGroups?.has(group)).length / total;
  }
  return usage;
}

/**
 * Score a whole run: the gate against `shouldRoute`, and each tool group
 * against what the turns actually used.
 *
 * Group scores cover only the turns the gate routed (those are the ones a
 * prediction exists for); the gate covers every turn. Usage rates cover every
 * turn, because "can this group be predicted" is a different question from
 * "is it worth predicting at all".
 */
export function scoreRun(rows) {
  const gate = scoreBinary(
    rows.map((row) => ({ truth: Boolean(row.shouldRoute), predicted: Boolean(row.didRoute) })),
  );
  const judged = rows.filter((row) => row.predictedGroups instanceof Set);
  const groups = {};
  for (const group of [...Object.keys(TOOL_GROUPS), "other"]) {
    groups[group] = scoreBinary(
      judged.map((row) => ({
        truth: row.truthGroups.has(group),
        predicted: row.predictedGroups.has(group),
      })),
    );
  }
  return {
    gate,
    groups,
    usage: groupUsage(rows),
    coverage: coverageReport(judged),
    turns: rows.length,
    judged: judged.length,
  };
}
