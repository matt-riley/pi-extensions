// model-battery.mjs — the judged half of model choice.
//
// Measured on 90 turns from this machine's sessions, against labels derived
// from real spend per million context tokens:
//
//   difficulty (score)     AUC 0.70   frontier p50 1.46 vs 1.01 other
//   needs_frontier (noul)  AUC 0.55   barely better than chance
//
// The decision-shaped question is the weaker instrument, which is why the
// router thresholds a *rating* instead of asking "would a cheap model fail?".
// At >= 1.5 the rating is 77% precise at 48% recall and catches 11 of the 12
// most expensive turns in the corpus, including both that the deterministic
// rules confidently downgraded. Details: scripts/difficulty-report.mjs.
//
// Both the report script and the extension build their state here, so what was
// measured is exactly what runs.

/** How many turns of conversation the judgement sees. */
export const WINDOW = 4;

/** Measured operating point: quality-leaning. Lower finds more, costs more. */
export const DIFFICULTY_THRESHOLD = 1.5;

/**
 * Models that count as frontier, best first, matched as substrings of
 * "provider/model".
 *
 * GPT entries are provider-qualified on purpose: the same model is offered by
 * several subscriptions, and OpenAI's own should pay for it. An unqualified
 * pattern would let whichever provider the catalogue happens to list first win
 * — a live run picked github-copilot/gpt-6-astra before this was pinned.
 */
export const DEFAULT_FRONTIER_PATTERNS = [
  "openai-codex/gpt-6-astra",
  "openai-codex/gpt-5.6-sol",
  "grok-4.6",
  "qwen3.8-max",
  "kimi-k3",
];

/**
 * Providers to prefer when several candidates match the same pattern.
 *
 * Patterns are only half the rule: a GPT pattern can still match a reseller,
 * so this decides between matches. Custom patterns passed via
 * `PI_ROUTER_FRONTIER` get the same treatment.
 */
const DEFAULT_PROVIDER_PREFERENCE = ["openai-codex"];

/** Lower rank wins; unlisted providers tie and keep catalogue order. */
function providerRank(key, providers) {
  const provider = String(key).split("/")[0]?.toLowerCase() ?? "";
  const index = providers.findIndex((entry) => String(entry).toLowerCase() === provider);
  return index === -1 ? providers.length : index;
}

const DIFFICULTY_LEVELS = [
  "Any capable small model would satisfy this in one attempt.",
  "A mid-tier model would satisfy this; a small one might need a retry.",
  "A strong model is needed: multi-step reasoning over this codebase, or several constraints to hold at once.",
  "Frontier territory: subtle design or debugging where a weak answer costs a lot and nobody will notice it is wrong.",
];

export function buildQuestions() {
  return {
    difficulty: {
      type: "score",
      instructions:
        "How hard is `prompt` to satisfy well, given `conversation`? Judge the work involved, not the length of the " +
        "message. A short message can be hard: it may be a follow-up inside a long, difficult task, or a rejection " +
        "of several failed attempts. A long message can be easy: it may be a paste of context with a simple ask.",
      criteria: DIFFICULTY_LEVELS,
    },
    needs_frontier: {
      type: "noul",
      instructions:
        "Considering `conversation` as well as `prompt`: is a cheaper or mid-tier model likely to fail at this, or need " +
        "several attempts, where a frontier model would get it right? Answer no when a cheaper model would very " +
        "likely handle it.",
      criteria: {
        true: "The work involves subtle diagnosis, design, or many interacting constraints; several failed attempts are already visible in the conversation.",
        false:
          "Ordinary implementation, mechanical edits, lookups, or short confirmations that any capable model handles.",
      },
    },
  };
}

/**
 * Group a session branch into turns, the way the measured state expects.
 *
 * Tolerates both shapes pi hands out — entries carrying `message`, and bare
 * messages — because the SDK's branch type is loose and a router that crashes
 * on a shape change is worse than one that reads less.
 */
export function turnsFromBranch(branch, limit = WINDOW) {
  const turns = [];
  let current = null;
  for (const entry of Array.isArray(branch) ? branch : []) {
    const message = entry?.message ?? entry;
    if (!message?.role) continue;

    if (message.role === "user") {
      const text =
        typeof message.content === "string"
          ? message.content
          : Array.isArray(message.content)
            ? message.content
                .filter((block) => block?.type === "text" && typeof block.text === "string")
                .map((block) => block.text)
                .join(" ")
            : "";
      current = { prompt: text.trim(), lastResponse: "", toolCalls: [] };
      if (current.prompt) turns.push(current);
      else current = null;
      continue;
    }
    if (!current) continue;

    if (message.role === "assistant") {
      const text =
        typeof message.content === "string"
          ? message.content
          : Array.isArray(message.content)
            ? message.content
                .filter((block) => block?.type === "text" && typeof block.text === "string")
                .map((block) => block.text)
                .join(" ")
            : "";
      if (text.trim()) current.lastResponse = text.trim();
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (block?.type === "toolCall" && block.name)
          current.toolCalls.push({ name: block.name, isError: false });
      }
      continue;
    }
    if (message.role === "toolResult" && message.isError === true) {
      current.toolCalls.push({ name: message.toolName ?? "unknown", isError: true });
    }
  }
  return turns.slice(-limit);
}

/** The measured state: the prompt, the recent conversation, the directory. */
export function buildDifficultyState({ prompt, window, cwd } = {}) {
  return {
    prompt: String(prompt ?? "").slice(0, 2000),
    working_directory: cwd ?? null,
    conversation: (Array.isArray(window) ? window : []).map((turn) => ({
      prompt: String(turn.prompt ?? "").slice(0, 400),
      assistant_response: String(turn.lastResponse ?? "").slice(-400),
      failures: (turn.toolCalls ?? []).filter((call) => call.isError).length,
      tools_used: [...new Set((turn.toolCalls ?? []).map((call) => call.name))].slice(0, 12),
    })),
  };
}

function usableScore(answer) {
  if (!answer || answer.type !== "score") return null;
  const raw = answer.score;
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "string" && !raw.trim()) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/**
 * Difficulty rating → the routing decision.
 *
 * `escalate` is null when no usable rating came back, and the caller is
 * expected to keep the current model rather than guess.
 */
export function routeFromDifficulty(answers, thresholds = {}) {
  const threshold = Number.isFinite(thresholds.threshold)
    ? thresholds.threshold
    : DIFFICULTY_THRESHOLD;
  const difficulty = usableScore(answers?.difficulty);
  if (difficulty === null) {
    return { escalate: null, difficulty: null, reason: "no usable difficulty rating" };
  }
  if (difficulty >= threshold) {
    return {
      escalate: true,
      difficulty,
      reason: `difficulty ${difficulty.toFixed(2)} >= ${threshold}`,
    };
  }
  return {
    escalate: false,
    difficulty,
    reason: `difficulty ${difficulty.toFixed(2)} < ${threshold}`,
  };
}

/** "provider/id" for either a model object or a {model} wrapper. */
export function modelKey(model) {
  const value = model?.model ?? model;
  if (!value) return null;
  const provider = value.provider ?? value.providerId ?? "";
  const id = value.id ?? value.modelId ?? value.name ?? "";
  if (!provider && !id) return null;
  return provider ? `${provider}/${id}` : String(id);
}

/** Whether a key or pattern names its provider explicitly, as "provider/model". */
function namesProvider(value) {
  return String(value).includes("/");
}

/** A GPT model, however the provider spells it ("gpt-6-astra", "openai/gpt-5.6-sol"). */
function isGptKey(key) {
  return /(^|[/-])gpt[-.]/i.test(String(key));
}

/**
 * Pick the best frontier model available, respecting the session's own model
 * scoping: if the user used `--models`, routing must not reach outside it.
 *
 * GPT patterns are restricted to preferred providers even when the pattern does
 * not name one: a GPT model should be served by the subscription that owns it,
 * not by whichever reseller happens to list it first. A pattern that names its
 * provider is taken literally, and non-GPT patterns are never restricted.
 *
 * @param candidates [{model}|model strings] from ctx.scopedModels or getAvailable()
 * @param patterns   preference order, matched as substrings of "provider/id"
 * @param providers  providers a GPT pattern is allowed to resolve to
 */
export function chooseFrontierModel(
  candidates,
  patterns = DEFAULT_FRONTIER_PATTERNS,
  providers = DEFAULT_PROVIDER_PREFERENCE,
) {
  const keys = [];
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    const model = candidate?.model ?? candidate;
    const key = modelKey(model);
    if (key) keys.push({ key, model });
  }
  for (const pattern of patterns) {
    const needle = String(pattern).toLowerCase();
    const matches = keys.filter((entry) => entry.key.toLowerCase().includes(needle));
    if (!matches.length) continue;

    const restrict = !namesProvider(pattern) && matches.every((entry) => isGptKey(entry.key));
    const eligible = restrict
      ? matches.filter((entry) => providerRank(entry.key, providers) < providers.length)
      : matches;
    if (!eligible.length) continue;

    // Stable sort: equal-ranked providers keep catalogue order, so the choice
    // is deterministic rather than dependent on how the list arrived.
    const best = [...eligible].sort(
      (a, b) => providerRank(a.key, providers) - providerRank(b.key, providers),
    )[0];
    return { model: best.model, key: best.key, pattern };
  }
  return null;
}
