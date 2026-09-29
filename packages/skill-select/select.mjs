// select.mjs — TypeSafe-assisted skill selection.
//
// Lexical ranking is the offline floor. When a TypeSafe key is reachable,
// selectSkills shows Jev a wide pool, orders results by its probabilities and
// says so when no skill fits. Strictly fail-open: disabled, keyless, a provider
// error or an unusable answer all leave the lexical order untouched.

import { askSystemOne, resolveApiKey } from "../../shared/systemone.mjs";
import { DEFAULT_LIMIT, rankSkills } from "./library.mjs";

export const TIEBREAK_ENV = "PI_SKILL_SELECT_TIEBREAK";
// Selection is an interactive read: a slow provider must not stall the tool,
// so selection gets a much shorter budget than a deliberate agent question.
const TIEBREAK_TIMEOUT_MS = 3000;
const DECLINE_OPTION = "none_of_these";

/**
 * TypeSafe selection is on by default whenever a key is reachable — the env,
 * or the lore config file. Set PI_SKILL_SELECT_TIEBREAK to 0/false/off/no to
 * keep selection fully local.
 */
export function tiebreakEnabled(env = process.env) {
  if (!resolveApiKey(env)) {
    return false;
  }
  const flag = String(env?.[TIEBREAK_ENV] ?? "")
    .trim()
    .toLowerCase();
  return !["0", "false", "off", "no"].includes(flag);
}

/** A usable override only; a blank or junk value must not fall back to 30s. */
function shortBudget(env) {
  const configured = Number(env?.TYPESAFE_TIMEOUT_MS);
  return Number.isInteger(configured) && configured > 0
    ? String(configured)
    : String(TIEBREAK_TIMEOUT_MS);
}

// Why not just break ties? A tiebreak can only reorder the lexical top few, so a
// paraphrase whose words never reach the shortlist is unrecoverable, and a
// confidently wrong lexical winner is never questioned. Measured on 44 labelled
// cases (scripts/skill-select-eval.mjs): lexical 26 top-1, tie-only 29, this 39.

const POOL = 30;
const WIDE_MAX = 150;
/** Probability of none_of_these at or above which the result says so. */
const NONE_P = 0.6;
const WIDE_DESCRIPTION_CHARS = 200;
const DESCRIPTION_CHARS = 300;

const probability = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

export async function selectSkills({
  skills,
  query,
  limit = DEFAULT_LIMIT,
  env = process.env,
  ask = askSystemOne,
  signal,
} = {}) {
  const text = String(query ?? "").trim();
  const lexical = rankSkills(skills, text, { limit: Math.max(limit, POOL) });
  const fallback = (reason, extra = {}) => ({
    matches: lexical.slice(0, limit),
    note: null,
    reason,
    ...extra,
  });
  if (!text) return fallback("no_query");
  if (!tiebreakEnabled(env)) return fallback("disabled");

  // Lexical can be confidently wrong ("build" in a name), so it only orders the
  // pool; when the library is small enough, the pool is all of it.
  const scoreOf = new Map(lexical.map((entry) => [entry.name, entry.score]));
  const wide = skills.length <= WIDE_MAX;
  const pool = wide
    ? skills.map((entry) => ({ ...entry, score: scoreOf.get(entry.name) ?? 0 }))
    : lexical;
  if (pool.length < 2) return fallback("too_few_candidates");

  const chars = pool.length > 40 ? WIDE_DESCRIPTION_CHARS : DESCRIPTION_CHARS;
  const criteria = Object.fromEntries(
    pool.map((entry) => [
      entry.name,
      entry.description ? String(entry.description).slice(0, chars) : null,
    ]),
  );
  criteria[DECLINE_OPTION] =
    "General work no listed skill specifically covers: a simple question, a trivial edit, or chit-chat";

  try {
    const result = await ask({
      state: { task: text },
      questions: {
        best: {
          type: "choice",
          instructions:
            "Which listed skill should an assistant read before doing the task at `task`? Judge what the task " +
            "is really about, not word overlap. Choose none_of_these when the task is general work that no " +
            "listed skill specifically covers.",
          criteria,
        },
      },
      env: { ...env, TYPESAFE_TIMEOUT_MS: shortBudget(env) },
      signal,
    });
    const answer = result?.answers?.best;
    if (answer?.type !== "choice" || typeof answer.choice !== "string") {
      return fallback("unusable_answer");
    }
    const probs = answer.probabilities ?? {};
    const byName = new Map(pool.map((entry) => [entry.name, entry]));
    // Distribution when present; otherwise at least honour the chosen option.
    const p = (name) => probability(probs[name]) ?? (name === answer.choice ? 1 : 0);
    const ranked = [...byName.values()]
      .map((entry) => ({ ...entry, p: p(entry.name) }))
      .filter((entry) => entry.p > 0)
      .sort((a, b) => b.p - a.p || b.score - a.score || a.name.localeCompare(b.name));
    const none = p(DECLINE_OPTION);
    const note =
      none >= NONE_P
        ? `TypeSafe: no listed skill clearly fits this task (p=${none.toFixed(2)}). Proceed without a skill unless one below obviously applies.`
        : null;
    // All probability on none_of_these leaves nothing ranked: show lexical, with the note.
    if (ranked.length === 0) return fallback("declined", { note, none });
    return { matches: ranked.slice(0, limit), note, reason: wide ? "wide" : "shortlist", none };
  } catch (error) {
    return fallback("request_failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
