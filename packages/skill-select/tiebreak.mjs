// tiebreak.mjs — optional TypeSafe tiebreaker for skill selection.
//
// Lexical ranking handles most queries. When the top scores are close, one
// choice question over the candidates decides which skill the agent should
// read. Opt-in (PI_SKILL_SELECT_TIEBREAK) and strictly fail-open: disabled,
// keyless, separated scores, provider errors, or a declined answer all leave
// the lexical order untouched.

import { askSystemOne, resolveApiKey } from "../../shared/systemone.mjs";

export const TIEBREAK_ENV = "PI_SKILL_SELECT_TIEBREAK";
export const MAX_CANDIDATES = 8;
export const DEFAULT_MIN_GAP = 1.5;
// Selection is an interactive read: a slow provider must not stall the tool,
// so tiebreaks get a much shorter budget than a deliberate agent question.
export const TIEBREAK_TIMEOUT_MS = 3000;
export const DECLINE_OPTION = "none_of_these";

/**
 * Tiebreaking is on by default whenever a TypeSafe key is reachable — the env,
 * or the lore config file. Set PI_SKILL_SELECT_TIEBREAK to 0/false/off/no to
 * keep selection fully local.
 */
export function tiebreakEnabled(env = process.env) {
  if (!resolveApiKey(env)) {
    return false;
  }
  const flag = String(env?.[TIEBREAK_ENV] ?? "").trim().toLowerCase();
  return !["0", "false", "off", "no"].includes(flag);
}

/** Close top scores mean the lexical order is not a clear answer. */
export function needsTiebreak(matches, { minGap = DEFAULT_MIN_GAP } = {}) {
  if (!Array.isArray(matches) || matches.length < 2) {
    return false;
  }
  const [first, second] = matches;
  return Number(first?.score ?? 0) - Number(second?.score ?? 0) <= minGap;
}

/** A usable override only; a blank or junk value must not fall back to 30s. */
function shortBudget(env) {
  const configured = Number(env?.TYPESAFE_TIMEOUT_MS);
  return Number.isInteger(configured) && configured > 0 ? String(configured) : String(TIEBREAK_TIMEOUT_MS);
}

/**
 * Promote the skill TypeSafe picks when the lexical top scores are close.
 *
 * @param {{
 *   query: string,
 *   matches: Array<{ name: string, description?: string, score?: number }>,
 *   env?: Record<string, string | undefined>,
 *   ask?: typeof askSystemOne,
 *   minGap?: number,
 * }} opts
 * @returns {Promise<{ matches: Array<object>, applied: boolean, reason: string, chosen?: string, error?: string }>}
 */
export async function tiebreakMatches({
  query,
  matches,
  env = process.env,
  ask = askSystemOne,
  signal,
  minGap = DEFAULT_MIN_GAP,
} = {}) {
  const list = Array.isArray(matches) ? matches : [];
  if (!tiebreakEnabled(env)) {
    return { matches: list, applied: false, reason: "disabled" };
  }
  // Browsing the catalog gives every row score 0, which would look like a
  // perfect tie and spend a paid call unscrambling alphabetical order.
  if (!String(query ?? "").trim()) {
    return { matches: list, applied: false, reason: "no_query" };
  }
  if (!needsTiebreak(list, { minGap })) {
    return { matches: list, applied: false, reason: "scores_separated" };
  }

  try {
    const candidates = list.slice(0, MAX_CANDIDATES).filter((entry) => entry && typeof entry.name === "string");
    if (candidates.length < 2) {
      return { matches: list, applied: false, reason: "too_few_candidates" };
    }
    const criteria = Object.fromEntries(
      candidates.map((entry) => [entry.name, entry.description ? String(entry.description).slice(0, 300) : null]),
    );
    criteria[DECLINE_OPTION] = "None of the listed skills fits the task";

    const result = await ask({
      state: { task: String(query ?? "") },
      questions: {
        best: {
          type: "choice",
          instructions: "Which listed skill best fits the task at `task`, if any? Choose none_of_these when no listed skill is a genuine match.",
          criteria,
        },
      },
      env: {
        ...env,
        TYPESAFE_TIMEOUT_MS: shortBudget(env),
      },
      signal,
    });

    const choice = result?.answers?.best?.choice;
    if (typeof choice !== "string" || choice === DECLINE_OPTION) {
      return { matches: list, applied: false, reason: "declined", chosen: null };
    }
    // Only a candidate the model was actually shown can be promoted.
    const index = candidates.findIndex((entry) => entry.name === choice);
    if (index < 0) {
      return { matches: list, applied: false, reason: "unknown_choice", chosen: choice };
    }
    if (index === 0) {
      return { matches: list, applied: false, reason: "already_top", chosen: choice };
    }
    const chosen = candidates[index];
    const chosenIndex = list.indexOf(chosen);
    return {
      matches: [chosen, ...list.filter((_, position) => position !== chosenIndex)],
      applied: true,
      reason: "reordered",
      chosen: chosen.name,
      over: list[0]?.name ?? null,
      chosenScore: chosen.score ?? null,
      overScore: list[0]?.score ?? null,
    };
  } catch (error) {
    return {
      matches: list,
      applied: false,
      reason: "request_failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
