// plan-review.mjs — the plan review AGENTS.md asks for, done by code.
//
// "Before presenting a plan, ask Jev whether each step names its verification
// and whether the affected callers are identified." That is a per-step
// judgment, so code splits the plan into steps and asks both questions for
// every step in one request. The answer is appended to the plan file, where
// the person reviewing the plan will see it.
//
// It never blocks a plan: a missing key, a timeout or an unusable answer means
// no appendix, and the plan is written as it was.

import { askSystemOne } from "../../shared/systemone.mjs";
import { usableNumber } from "../../shared/systemone.mjs";

const MAX_STEPS = 10;
const MAX_STEP_CHARS = 800;
const MAX_PLAN_CHARS = 40_000;
const MISSING = 0.5;

/** A backticked reference to a state path, the way these prompts name their input. */
const q = (name) => "`" + name + "`";

/**
 * The steps of a plan, in order.
 *
 * A plan is prose, so there is no parser that is always right. Lists first —
 * a checklist is what a step looks like — then headings, then the paragraphs.
 * A plan with none of those is one step, which is still worth judging.
 */
export function splitSteps(plan) {
  const body = String(plan ?? "").slice(0, MAX_PLAN_CHARS);
  const clean = (text) =>
    text
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_STEP_CHARS);

  const fromLists = body
    .split(/\r?\n/)
    .filter((line) => /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(line))
    .map(clean)
    .filter((step) => step.length >= 20);

  const fromHeadings = body
    .split(/\r?\n(?=#{2,4}\s)/)
    .filter((section) => /^#{2,4}\s/.test(section))
    .map((section) => section.replace(/^#{2,4}\s+[^\n]*\n?/, ""))
    .map(clean)
    .filter((step) => step.length >= 20);

  const chosen = fromLists.length > 0 ? fromLists : fromHeadings;
  if (chosen.length === 0) {
    const whole = clean(body);
    return whole.length >= 20 ? [whole] : [];
  }
  return chosen.slice(0, MAX_STEPS);
}

export function buildReviewQuestions(count) {
  const questions = {};
  for (let index = 0; index < count; index += 1) {
    const step = q("steps." + index + ".text");
    questions["verification_" + index] = {
      type: "noul",
      instructions:
        "Read " +
        step +
        ". Does the step say how its result will be checked — a test, a " +
        "command, an observable behaviour — or name the check the repository already runs? A " +
        "step that only says what to change does not.",
      criteria: {
        true: "The step names how it is verified, or the effect that proves it worked.",
        false: "The step describes a change and leaves how to verify it unstated.",
      },
    };
    questions["callers_" + index] = {
      type: "noul",
      instructions:
        "Read " +
        step +
        ". Does the step identify the code it affects — the callers, " +
        "consumers, entry points or files that must change with it — or is it purely additive " +
        "with nothing yet calling it? A step that changes shared behaviour without saying what " +
        "else relies on it does not.",
      criteria: {
        true: "The step names its callers or consumers, or adds code nothing calls yet.",
        false: "The step changes existing behaviour without identifying what depends on it.",
      },
    };
  }
  return questions;
}

/** Which steps fall short, worst first within each list. */
export function routePlanReview(answers, steps) {
  const rows = steps.map((text, index) => ({
    index,
    text,
    verification: usableNumber(answers?.["verification_" + index]?.noul),
    callers: usableNumber(answers?.["callers_" + index]?.noul),
  }));
  const missingVerification = rows
    .filter((row) => row.verification !== null && row.verification < MISSING)
    .sort((left, right) => left.verification - right.verification);
  const missingCallers = rows
    .filter((row) => row.callers !== null && row.callers < MISSING)
    .sort((left, right) => left.callers - right.callers);
  return { rows, missingVerification, missingCallers };
}

/** The appendix, or null when every step held up (or nothing could be judged). */
export function formatPlanReview({ rows, missingVerification, missingCallers } = {}) {
  if (!rows || rows.length === 0) return null;
  if (missingVerification.length === 0 && missingCallers.length === 0) {
    return [
      "## Plan check",
      "",
      "Every step names its verification and identifies what else depends on it " +
        "(TypeSafe judgment over the " +
        rows.length +
        " step(s) above).",
    ].join("\n");
  }
  const lines = ["## Plan check", "", "TypeSafe read the steps above and found:"];
  const section = (title, rows_) => {
    if (rows_.length === 0) return;
    lines.push("");
    lines.push(title);
    for (const row of rows_) {
      lines.push("- step " + (row.index + 1) + " — " + row.text);
    }
  };
  section("No verification named:", missingVerification);
  section("Affected callers not identified:", missingCallers);
  lines.push("");
  lines.push(
    "This is a reading of the plan text, not of the code. Edit the step or say why it holds.",
  );
  return lines.join("\n");
}

/**
 * Ask, then return the appendix to append. Any failure is a null appendix: a
 * plan review is a courtesy, and a plan that cannot be written is worse.
 */
export async function reviewPlan({
  plan,
  steps = splitSteps(plan),
  timeoutMs = 8_000,
  model,
  env,
  ask = askSystemOne,
} = {}) {
  if (steps.length === 0) return { appendix: null, judged: false, reason: "the plan has no steps" };
  try {
    const result = await ask({
      state: { steps: steps.map((text) => ({ text })) },
      questions: buildReviewQuestions(steps.length),
      model,
      env,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const routed = routePlanReview(result?.answers, steps);
    const judged = routed.rows.some((row) => row.verification !== null || row.callers !== null);
    return {
      appendix: judged ? formatPlanReview(routed) : null,
      judged,
      ...routed,
      model: result?.model,
      usage: result?.usage ?? null,
    };
  } catch (error) {
    return {
      appendix: null,
      judged: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
