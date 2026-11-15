// evidence.mjs — does the log back up a "tests passed" claim?
//
// The gate records each check it sees (command, kind, status, the tail of its
// log). A closing message that says the tests passed is read against those
// records with plain code: no model, no key. A claim with no run behind it, a
// run that failed, a log that reports failures or no tests, and a test count
// the log never shows are all findings.

const LOG_CHARS = 4000;

/** The text of a tool result's content, as its last 4,000 characters. */
export function logText(content) {
  const text =
    typeof content === "string"
      ? content
      : (Array.isArray(content) ? content : [])
          .filter((part) => part?.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("\n");
  return text.length > LOG_CHARS ? text.slice(text.length - LOG_CHARS) : text;
}

const SUBJECT = /\b(?:tests?|specs?|suite|checks?)\b/i;
const PASSED = /\b(?:pass(?:es|ed|ing)?|green)\b/i;
// A sentence that names a gap or a failure is not the plain claim this checks.
const HEDGED = /\b(?:not|never|no|without|unable|except|but|fail\w*)\b|n't/i;

/** True when a sentence of `claim` plainly says that tests or checks passed. */
export function claimsTestsPassed(claim) {
  return String(claim ?? "")
    .split(/[.!?\n]+/)
    .some((sentence) => SUBJECT.test(sentence) && PASSED.test(sentence) && !HEDGED.test(sentence));
}

const count = (text, pattern) => {
  const found = pattern.exec(text);
  return found ? Number(found[1]) : 0;
};

function logReportsFailures(log) {
  return (
    count(log, /^# fail (\d+)/m) > 0 ||
    count(log, /\b(\d+) (?:failed|failing|failures?)\b/i) > 0 ||
    /^\s*(?:FAIL|FAILED)\b/m.test(log)
  );
}

const NO_TESTS = [
  /^# tests 0\b/m,
  /\bRan 0 tests\b/i,
  /\bcollected 0 items\b/i,
  /\bno tests? (?:found|ran|to run)\b/i,
  /\b0 (?:passed|passing)\b/i,
];

/**
 * Why the recorded runs do not back a "tests passed" claim, or null when they
 * do (or when the claim is not one). `runs` are in order, oldest first;
 * `edited` is whether this input changed code.
 */
export function testClaimGap({ claim, runs = [], edited = false } = {}) {
  if (!claimsTestsPassed(claim)) return null;
  const run = runs.findLast((item) => item.kind === "behavior");
  if (!run) {
    if (runs.length > 0)
      return "only compile or lint checks were recorded, and none that runs the code";
    return edited ? "no check was recorded after your edits" : null;
  }
  if (run.status === "failed") return `\`${run.command}\` failed`;
  if (run.status !== "passed") return `\`${run.command}\` has no clean result on the final tree`;
  const log = String(run.log ?? "");
  if (!log.trim()) return null;
  if (logReportsFailures(log)) return `the log of \`${run.command}\` reports failures`;
  if (NO_TESTS.some((pattern) => pattern.test(log))) {
    return `the log of \`${run.command}\` shows no tests ran`;
  }
  const claimed = /\b(\d+)\s+(?:(?:unit|integration|e2e)\s+)?(?:tests?|specs?)\b/i.exec(claim)?.[1];
  if (claimed && !new RegExp(`\\b${claimed}\\b`).test(log)) {
    return `your message says ${claimed} tests, the log of \`${run.command}\` does not show ${claimed}`;
  }
  return null;
}

/** The sentence the nudge gains for a gap `testClaimGap` found. */
export function claimGapLine(gap) {
  return (
    `Your closing message says the tests passed, but ${gap}. ` +
    "Say what was actually run and what it showed, or correct the claim."
  );
}
