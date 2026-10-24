// findings.mjs — check a review finding against the diff it claims to be about.
//
// A review finding that quotes code is checkable by string comparison: if the
// quoted text is not in the diff, no judgment is needed, because the finding is
// about code that is not there. Only the survivors go to Jev — does the diff
// show the defect, and how serious is it — so a fabricated finding costs nothing
// and a real one costs one question.
//
// Code keeps the cheap half. That is the same split as the guardrail: decide
// what shape decides, judge the rest.

import { askSystemOne } from "../../shared/systemone.mjs";
import { usableNumber } from "../../shared/systemone.mjs";
import { MAX_DIFF_CHARS, capDiff } from "./lint.mjs";

const MAX_FINDINGS = 10;
const MAX_FINDING_CHARS = 800;
const MIN_QUOTE_CHARS = 6;

const SEVERITY_LEVELS = [
  "Nitpick: style, wording or preference; nothing behaves differently.",
  "Worth fixing: a real defect, but not blocking.",
  "Blocking: incorrect behaviour, data loss, a security issue, or a documented rule violation.",
];

/** Backticked and double-quoted spans: how a review finding quotes the code. */
export function extractQuotes(text) {
  const quotes = [];
  for (const match of String(text ?? "").matchAll(/`([^`\n]{6,200})`|"([^"\n]{6,200})"/g)) {
    const quote = (match[1] ?? match[2] ?? "").trim();
    if (quote.length >= MIN_QUOTE_CHARS) quotes.push(quote);
  }
  return quotes;
}

/** A backticked reference to a state path, the way these prompts name their input. */
const q = (name) => "`" + name + "`";

/** Whitespace-insensitive text, so a quote wrapped differently still matches. */
const normalize = (text) =>
  String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Whether the finding's own quotation appears in the diff.
 *
 * "none" means it quoted nothing, which is not the same as a failed check: the
 * judgment can still say whether the finding describes the change.
 */
export function quoteStatus(finding, diffText) {
  const quotes = extractQuotes(finding);
  if (quotes.length === 0) return { status: "none", quotes };
  const haystack = normalize(diffText);
  const found = quotes.every((quote) => haystack.includes(normalize(quote)));
  return { status: found ? "found" : "missing", quotes };
}

/**
 * The questions for one finding. Ids are for code; the finding is named by its
 * index in the state so each question carries its own meaning.
 */
function buildFindingQuestions(index) {
  const path = "findings." + index + ".text";
  return {
    ["support_" + index]: {
      type: "noul",
      instructions:
        "Read " +
        q(path) +
        " and " +
        q("diff") +
        ". Does the diff contain the change the " +
        "finding describes, and is it a real defect rather than a style preference? A finding " +
        "about code the diff does not touch is not supported.",
      criteria: {
        true: "The diff shows the problem the finding names.",
        false: "The diff does not show it, or what it shows is a matter of preference.",
      },
    },
    ["severity_" + index]: {
      type: "score",
      instructions:
        "Read " +
        q(path) +
        " and " +
        q("diff") +
        ". If this finding is real, how serious is " +
        "the defect? Judge the consequence, not how confident the finding sounds.",
      criteria: SEVERITY_LEVELS,
    },
  };
}

/** Answers routed per finding: kept when supported or quoting the code. */
function routeVerified(answers, prepared) {
  const kept = [];
  const dropped = [];
  for (const entry of prepared) {
    const support = usableNumber(answers?.["support_" + entry.index]?.noul);
    const severity = usableNumber(answers?.["severity_" + entry.index]?.score);
    const supported = support !== null && support >= 0.5;
    if (!supported && entry.quote.status !== "found") {
      dropped.push({ ...entry, reason: "the diff does not show it", support, severity });
      continue;
    }
    kept.push({ ...entry, support, severity });
  }
  kept.sort(
    (a, b) => (b.severity ?? -1) - (a.severity ?? -1) || (b.support ?? 0) - (a.support ?? 0),
  );
  return { kept, dropped };
}

/** The review a person can act on: strongest first, and what was thrown away. */
export function formatVerified({ kept, dropped, truncated, judged, reason }) {
  const lines = [];
  if (!judged) {
    lines.push("Not verified: " + (reason ?? "no judgment"));
  }
  lines.push(
    kept.length +
      " of " +
      (kept.length + dropped.length) +
      " findings hold" +
      (truncated ? " · diff cut at " + MAX_DIFF_CHARS + " characters" : ""),
  );
  for (const entry of kept) {
    const level = entry.severity === null ? null : SEVERITY_LEVELS[Math.round(entry.severity)];
    const severity = level ? level.split(":")[0].toLowerCase() : "severity ?";
    const support = entry.support === null ? "support ?" : "support " + entry.support.toFixed(2);
    const quote = entry.quote.status === "found" ? "quote ok" : "no quote";
    lines.push("[" + severity.toLowerCase() + " · " + support + " · " + quote + "] " + entry.text);
  }
  for (const entry of dropped) {
    lines.push("Dropped: " + entry.text + " — " + entry.reason);
  }
  return lines.join("\n");
}

/**
 * Verify review findings against a diff.
 *
 * Findings whose own quotation is absent from the diff never reach the model:
 * there is nothing in the change for the finding to be about, and that is a
 * string comparison. Everything else is asked in one request.
 */
export async function verifyFindings({
  findings,
  diff,
  timeoutMs = 12_000,
  model,
  env,
  ask = askSystemOne,
  signal,
} = {}) {
  const list = (Array.isArray(findings) ? findings : [])
    .map((item) => (typeof item === "string" ? item : (item?.text ?? item?.claim ?? "")))
    .map((text) => String(text).trim().slice(0, MAX_FINDING_CHARS))
    .filter(Boolean)
    .slice(0, MAX_FINDINGS);
  if (list.length === 0) {
    return {
      kept: [],
      dropped: [],
      judged: false,
      truncated: false,
      reason: "no findings to verify",
    };
  }
  const capped = capDiff(diff);
  const prepared = [];
  const dropped = [];
  for (const [index, text] of list.entries()) {
    const quote = quoteStatus(text, capped.text);
    if (quote.status === "missing") {
      dropped.push({ index, text, quote, reason: "quoted text is not in the diff" });
      continue;
    }
    prepared.push({ index, text, quote });
  }
  if (prepared.length === 0) {
    return {
      kept: [],
      dropped,
      judged: false,
      truncated: capped.truncated,
      reason: "no finding survived its own quotation",
    };
  }
  const questions = Object.assign(
    {},
    ...prepared.map((entry) => buildFindingQuestions(entry.index)),
  );
  const state = {
    diff: capped.text,
    findings: prepared.map((entry) => ({ text: entry.text })),
  };
  try {
    const result = await ask({
      state,
      questions,
      model,
      env,
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    });
    const routed = routeVerified(result?.answers, prepared);
    return {
      ...routed,
      dropped: [...dropped, ...routed.dropped],
      judged: true,
      truncated: capped.truncated,
      model: result?.model,
      usage: result?.usage ?? null,
    };
  } catch (error) {
    return {
      kept: [],
      dropped: [...dropped, ...prepared.map((entry) => ({ ...entry, reason: "not judged" }))],
      judged: false,
      truncated: capped.truncated,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
