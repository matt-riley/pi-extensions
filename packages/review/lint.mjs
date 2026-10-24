// lint.mjs — route the preference answers into findings.
//
// Nothing here decides a judgement: the questions are in rules.mjs, the model
// answers them, and this file applies the only thing code is good at — a
// threshold, a sort, and a line a person can act on.

import { askSystemOne } from "../../shared/systemone.mjs";
import { usableNumber } from "../../shared/systemone.mjs";
import { DEFAULT_THRESHOLD, RULES_BY_ID, buildQuestionSet } from "./rules.mjs";

/**
 * The state budget. Jev refuses a state past 60000 characters, and a diff is
 * the one input here that routinely exceeds it, so the cut is made where it can
 * be reported instead of discovered as a failed request.
 */
export const MAX_DIFF_CHARS = 45_000;

const MAX_FILES = 60;

/** The diff, cut to the budget, with whether the cut happened. */
export function capDiff(diff, max = MAX_DIFF_CHARS) {
  const text = String(diff ?? "");
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max), truncated: true };
}

const TEST_FILE = /(?:^|\/)(?:test|tests|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/i;

const isTestPath = (file) => TEST_FILE.test(String(file ?? ""));

/**
 * What code can check about a Conventional Commit subject, checked (not asked):
 * the shape is a regex, and asking a model to apply a regex is how a lint starts
 * disagreeing with itself.
 */
export function conventionalProblems(message) {
  const subject = String(message ?? "")
    .split("\n")[0]
    .trim();
  if (!subject) return ["the commit message is empty"];
  const problems = [];
  const match =
    /^(feat|fix|docs|refactor|test|chore|perf|style|build|ci|revert)(?:\([^)]+\))?(!)?: (.+)$/.exec(
      subject,
    );
  if (!match) {
    problems.push("subject is not type(scope): text with a known type");
  } else {
    const text = match[3];
    if (text.endsWith(".")) problems.push("subject ends with a period");
    if (/^[A-Z]/.test(text)) problems.push("subject starts with a capital letter");
    if (subject.length > 72)
      problems.push("subject is " + subject.length + " characters (over 72)");
  }
  if (String(message ?? "").includes("BREAKING CHANGE:") && !match?.[2]) {
    problems.push("a BREAKING CHANGE footer without a ! in the subject");
  }
  return problems;
}

/**
 * Answers above their rule's threshold, strongest first.
 *
 * A rule that came back unusable is dropped rather than routed: an absent value
 * is not a confident zero, and a lint that reports on no evidence is worse than
 * one that stays quiet.
 */
export function routeFindings(answers) {
  const findings = [];
  for (const [id, answer] of Object.entries(answers ?? {})) {
    const rule = RULES_BY_ID.get(id);
    if (!rule || answer?.type !== "noul") continue;
    const probability = usableNumber(answer.noul);
    if (probability === null) continue;
    const threshold = rule.threshold ?? DEFAULT_THRESHOLD;
    if (probability < threshold) continue;
    findings.push({ id, label: rule.label, probability, threshold });
  }
  return findings.sort((a, b) => b.probability - a.probability || a.id.localeCompare(b.id));
}

/** One line per finding, or the empty string. */
export function formatFindings(findings) {
  return findings
    .map((finding) => finding.id + " " + finding.probability.toFixed(2) + " — " + finding.label)
    .join("\n");
}

/**
 * Judge one change.
 *
 * Returns rather than throws when the caller asked for a judgment and did not
 * get one: the tool reports the error, the script exits non-zero, and neither
 * invents a pass.
 */
export async function lintChange({
  diff,
  files = [],
  message,
  task,
  timeoutMs = 12_000,
  model,
  env,
  ask = askSystemOne,
  signal,
} = {}) {
  const capped = capDiff(diff);
  const list = Array.isArray(files) ? files.slice(0, MAX_FILES) : [];
  const questions = buildQuestionSet({
    message,
    task,
    hasTests: list.some(isTestPath),
  });
  const subject = message ? conventionalProblems(message) : [];
  if (Object.keys(questions).length === 0) {
    return {
      findings: [],
      subject,
      judged: false,
      truncated: capped.truncated,
      reason: "no rules apply to this change",
    };
  }
  const state = {
    diff: capped.text,
    files: list,
    message: message ?? null,
    task: task ?? null,
    diff_truncated: capped.truncated,
  };
  try {
    const result = await ask({
      state,
      questions,
      model,
      env,
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    });
    return {
      findings: routeFindings(result?.answers),
      subject,
      judged: true,
      truncated: capped.truncated,
      model: result?.model,
      usage: result?.usage ?? null,
    };
  } catch (error) {
    return {
      findings: [],
      subject,
      judged: false,
      truncated: capped.truncated,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
