// lib.mjs — the pure half of the routing harness.
//
// No I/O, no network, no model: turn features, ground truth and the task-boundary
// gate. Ground truth is what a turn *used*: the groups whose tools appear in it.

/** Tool groups, by the real tool names seen in this repo's sessions. */
const TOOL_GROUPS = {
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
  web: ["web_fetch", "batch_web_fetch", "web_search", "web_answer", "plan_fetch_url"],
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
  judge: ["typesafe_ask", "lint_change", "verify_findings"],
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

/** Same threshold as `STUCK_FAILURES` in index.ts — previous turn had this many tool errors. */
const STUCK_FAILURES = 2;

function failedCallsInTurn(turn) {
  return (turn?.toolCalls ?? []).filter((call) => call.isError).length;
}

/**
 * The routing gate: route on a shift, stay put on a continuation.
 *
 * Deliberately cheap and dumb, because its job is not to be clever — it is to
 * keep the judged call off the common case.
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
  if (words.size >= 3 && overlap < 0.2) {
    if (failedCallsInTurn(previousTurn) >= STUCK_FAILURES) {
      return {
        route: false,
        reason: "stuck continuation",
        signals: { ...signals, failuresLastTurn: failedCallsInTurn(previousTurn) },
      };
    }
    return { route: true, reason: "topic shift", signals };
  }
  return { route: false, reason: "looks like a continuation", signals };
}
