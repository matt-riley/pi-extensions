// tiebreak.mjs — optional TypeSafe tiebreaker for skill selection.
//
// Lexical ranking handles most queries. When the top scores are close, one
// choice question over the candidates decides which skill the agent should
// read. Opt-in (PI_SKILL_SELECT_TIEBREAK) and strictly fail-open: disabled,
// keyless, separated scores, provider errors, or a declined answer all leave
// the lexical order untouched.

import { askSystemOne } from "../typesafe/systemone.mjs";

export const TIEBREAK_ENV = "PI_SKILL_SELECT_TIEBREAK";
export const MAX_CANDIDATES = 8;
export const DEFAULT_MIN_GAP = 1.5;
export const DECLINE_OPTION = "none_of_these";

/** Whether tiebreaking is switched on and can reach a provider. */
export function tiebreakEnabled(env = process.env) {
  const flag = String(env?.[TIEBREAK_ENV] ?? "").trim().toLowerCase();
  if (!flag || flag === "0" || flag === "false" || flag === "off" || flag === "no") {
    return false;
  }
  const key = env?.TYPESAFE_API_KEY || env?.LORE_TYPESAFE_API_KEY;
  return Boolean(String(key ?? "").trim());
}

/** Close top scores mean the lexical order is not a clear answer. */
export function needsTiebreak(matches, { minGap = DEFAULT_MIN_GAP } = {}) {
  if (!Array.isArray(matches) || matches.length < 2) {
    return false;
  }
  const [first, second] = matches;
  return Number(first?.score ?? 0) - Number(second?.score ?? 0) <= minGap;
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
  minGap = DEFAULT_MIN_GAP,
} = {}) {
  const list = Array.isArray(matches) ? matches : [];
  if (!tiebreakEnabled(env)) {
    return { matches: list, applied: false, reason: "disabled" };
  }
  if (!needsTiebreak(list, { minGap })) {
    return { matches: list, applied: false, reason: "scores_separated" };
  }

  const candidates = list.slice(0, MAX_CANDIDATES);
  const criteria = Object.fromEntries(
    candidates.map((entry) => [entry.name, entry.description ? String(entry.description).slice(0, 300) : null]),
  );
  criteria[DECLINE_OPTION] = "None of the listed skills fits the task";

  let result;
  try {
    result = await ask({
      state: { task: String(query ?? "") },
      questions: {
        best: {
          type: "choice",
          instructions: "Which listed skill best fits the task at `task`, if any? Choose none_of_these when no listed skill is a genuine match.",
          criteria,
        },
      },
      env,
    });
  } catch (error) {
    return {
      matches: list,
      applied: false,
      reason: "request_failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const choice = result?.answers?.best?.choice;
  if (typeof choice !== "string" || choice === DECLINE_OPTION) {
    return { matches: list, applied: false, reason: "declined", chosen: null };
  }
  const index = list.findIndex((entry) => entry.name === choice);
  if (index < 0) {
    return { matches: list, applied: false, reason: "unknown_choice", chosen: choice };
  }
  const promoted = [list[index], ...list.filter((_, position) => position !== index)];
  return { matches: promoted, applied: true, reason: "reordered", chosen: choice };
}
