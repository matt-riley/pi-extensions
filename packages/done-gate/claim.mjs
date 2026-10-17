// claim.mjs — the TypeSafe half of the done-gate.
//
// The gate decides what the run's shape can decide: edits happened after the
// last verification and no check has run since. What it cannot decide is
// whether the message about to close the run says so or quietly claims
// success. That is a judgment about prose, so it goes to System One as two
// typed questions whose answers code can route on. No parsing, no prose.
//
// Text only: a verdict becomes one line appended to the existing nudge, never
// a block. Every failure — no key, timeout, malformed response — degrades to
// no line at all, because a missing sentence is a smaller problem than a run
// that cannot finish.

import { askSystemOne, usableNumber } from "../../shared/systemone.mjs";

/** Short on purpose: the run has finished and the person is waiting for it. */
export const DEFAULT_TIMEOUT_MS = 4000;

const THRESHOLDS = {
  assertsVerified: 0.5,
  acknowledgesGap: 0.5,
};

const MAX_CLAIM_CHARS = 1500;
const MAX_FILES = 50;

function noulValue(answer) {
  if (!answer || answer.type !== "noul") return null;
  return usableNumber(answer.noul);
}

/**
 * The two questions, batched as one request.
 *
 * Each carries its whole meaning: question ids are for code and never reach
 * the model, and every question references the state paths it needs. A claim
 * that only lists what changed is not an assertion of verification, and a
 * claim that names its gap has already answered the nudge.
 */
export function buildClaimQuestionSet() {
  return {
    asserts_verified: {
      type: "noul",
      instructions:
        "Read `claim` in the state: the final message of a run that changed `changed_files` and ran no " +
        "verification afterwards, as `verification_seen` reports. Does the claim assert or imply that the " +
        "changed code was verified — tests run, checks pass, behavior exercised? Listing what changed, or " +
        "describing work as finished, is not by itself a claim of verification.",
      criteria: {
        true: "It claims the work is verified, correct, working, or complete on the strength of checks.",
        false:
          "It makes no claim that the changed code was verified, or says outright that it was not.",
      },
    },
    acknowledges_gap: {
      type: "noul",
      instructions:
        "Read `claim` in the state. Does it say plainly that the changed code was not exercised — that " +
        "checks were not run, could not run, or do not apply — so a reader knows what is left unverified?",
      criteria: {
        true: "The gap is stated: checks were skipped or unavailable, or the reader is told what is unverified.",
        false:
          "Nothing is said about verification, or the absence of checks is passed over silently.",
      },
    },
  };
}

/**
 * The state the questions read. Named fields rather than prose, and the claim
 * truncated: this is a judgment call, not an essay contest.
 */
export function buildClaimState({ claim, files, verificationSeen } = {}) {
  return {
    claim: String(claim ?? "").slice(0, MAX_CLAIM_CHARS),
    changed_files: Array.isArray(files) ? files.slice(0, MAX_FILES) : [],
    verification_seen: verificationSeen === true,
  };
}

/**
 * Route the answers. Thresholds live here, in code, where they can be read,
 * tested and changed without touching a prompt.
 *
 * An unclosed claim is the finding that earns a line; a claim that names its
 * gap is acknowledged and the gate stays quiet, because the nudge asked for
 * exactly that. Anything else is not a judgment and routes nowhere.
 */
export function routeClaim(answers, thresholds = THRESHOLDS) {
  const asserts = noulValue(answers?.asserts_verified);
  const acknowledges = noulValue(answers?.acknowledges_gap);

  if (asserts === null && acknowledges === null) {
    return { verdict: null, reason: "judge returned no usable answers", signals: {} };
  }

  const signals = { asserts_verified: asserts, acknowledges_gap: acknowledges };
  const described = [];
  if (asserts !== null) described.push(`asserts_verified ${asserts.toFixed(2)}`);
  if (acknowledges !== null) described.push(`acknowledges_gap ${acknowledges.toFixed(2)}`);
  const reason = `judge: ${described.join(" · ")}`;

  const assertsSuccess =
    asserts !== null &&
    asserts >= thresholds.assertsVerified &&
    (acknowledges === null || asserts > acknowledges);

  if (assertsSuccess) {
    return { verdict: "unclosed", reason, signals };
  }
  if (acknowledges !== null && acknowledges >= thresholds.acknowledgesGap) {
    return { verdict: "acknowledged", reason, signals };
  }
  return { verdict: null, reason, signals };
}

/**
 * The line the nudge gains, or nothing.
 *
 * Only an unclosed claim earns one: a claim that names what is unverified has
 * already done what the nudge asks for, and inventing a sentence for it would
 * teach the model to ignore the nudge.
 */
export function claimLine(judged) {
  if (!judged?.judged || judged.verdict !== "unclosed") return null;
  const signals = judged.signals ?? {};
  const numbers = [
    ["asserts_verified", signals.asserts_verified],
    ["acknowledges_gap", signals.acknowledges_gap],
  ]
    .filter(([, value]) => typeof value === "number" && Number.isFinite(value))
    .map(([name, value]) => `${name} ${value.toFixed(2)}`)
    .join(" · ");
  const evidence = numbers ? ` (${numbers})` : "";
  return (
    `TypeSafe reads that claim as done with the unverified edits unmentioned${evidence}. ` +
    "Name what is unverified, or run the checks."
  );
}

/**
 * Ask System One about the claim a run is about to close on.
 *
 * `ask` is injectable so the tests never touch the network. Any failure —
 * missing key, timeout, malformed response — returns `judged: false` instead
 * of throwing into the settle path. A run with no claim text to judge costs no
 * request at all.
 */
export async function judgeDoneClaim({
  claim,
  files,
  verificationSeen,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  thresholds = THRESHOLDS,
  model,
  env,
  ask = askSystemOne,
  signal,
} = {}) {
  if (!String(claim ?? "").trim()) {
    return { judged: false, verdict: null, reason: "no claim to judge", signals: {} };
  }
  const state = buildClaimState({ claim, files, verificationSeen });
  try {
    const result = await ask({
      state,
      questions: buildClaimQuestionSet(),
      model,
      env,
      signal: signal ?? AbortSignal.timeout(timeoutMs),
    });
    const routed = routeClaim(result?.answers, thresholds);
    if (routed.verdict === null) {
      return { ...routed, judged: false, reason: `judge unavailable: ${routed.reason}` };
    }
    return { ...routed, judged: true, model: result?.model, usage: result?.usage ?? null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      judged: false,
      verdict: null,
      reason: `judge unavailable: ${message}`,
      signals: {},
    };
  }
}
