// verify.mjs — the TypeSafe half of deslop.
//
// patterns.mjs can say a phrase is present. It cannot say the phrase makes the
// text worse, and both source skills insist on that difference: deslop-text
// calls its review advice and says never to trade a clear sentence for a
// warning-free one. So two judgments go to System One as typed questions:
//
//   1. the findings — do the flagged patterns make this text worse for its
//      reader, or is the text a clear one where a check fired (a precise term,
//      a quoted example, a catalogue of the patterns themselves)?
//   2. the result — after the agent rewrites, does the new text still say what
//      the old one said, and did the pattern leave or only move? deslop-text:
//      "a fix is where the next defect gets written".
//
// Text only. Every failure (no key, timeout, malformed answer) is `judged:
// false`, and the caller falls back to what the deterministic check can stand
// behind on its own.

import { askSystemOne, usableNumber } from "../../shared/systemone.mjs";

/** Short on purpose: this rides on an edit result the agent is waiting for. */
const VERIFY_TIMEOUT_MS = 4000;
/** Enough to judge a section; Jev refuses a state past 60000 characters. */
const MAX_TEXT_CHARS = 6000;
const MAX_FINDINGS = 12;
const FEATURE = "deslop";

export const THRESHOLDS = Object.freeze({
  worseForReader: 0.5,
  discussesPatterns: 0.6,
  meaningPreserved: 0.5,
  stillFormulaic: 0.7,
});

function noulValue(answer) {
  if (!answer || answer.type !== "noul") return null;
  return usableNumber(answer.noul);
}

const clip = (text) => String(text ?? "").slice(0, MAX_TEXT_CHARS);

function describe(signals) {
  return Object.entries(signals)
    .filter(([, value]) => typeof value === "number" && Number.isFinite(value))
    .map(([name, value]) => `${name} ${value.toFixed(2)}`)
    .join(" · ");
}

/** Question ids are for code; each instruction names the state paths it reads. */
export function buildFindingsQuestions() {
  return {
    worse_for_reader: {
      type: "noul",
      instructions:
        "Read `text` in the state: prose an AI coding agent just wrote into the file `path`. A " +
        "pattern check flagged the phrases listed in `findings`. Do the flagged patterns make " +
        "this text worse for its reader: filler, sales language, a stock formula standing where " +
        "a specific claim should be? A flagged word used as a precise technical term, or a " +
        "sentence that is clear as written, does not make the text worse.",
      criteria: {
        true: "The flagged patterns weaken the text; a careful editor would rewrite those sentences.",
        false: "The text is clear and specific as written; the flags are incidental.",
      },
    },
    discusses_patterns: {
      type: "noul",
      instructions:
        "Read `text` in the state and the flagged phrases in `findings`. Is the text itself about " +
        "writing patterns, so that the flagged phrases appear as quoted examples, as a list of " +
        "phrases to avoid, or as test data, and not as the text's own voice?",
      criteria: {
        true: "The flagged phrases are mentioned, quoted or catalogued, not used.",
        false: "The flagged phrases are the text's own wording.",
      },
    },
  };
}

export function buildFindingsState({ path, text, findings } = {}) {
  return {
    path: String(path ?? ""),
    text: clip(text),
    findings: (Array.isArray(findings) ? findings : []).slice(0, MAX_FINDINGS).map((item) => ({
      pattern: item.label,
      severity: item.severity,
      excerpts: item.excerpts,
    })),
  };
}

/**
 * Route the first judgment. Thresholds live in code, where a test can read
 * them. Without a usable `worse_for_reader` there is no verdict at all.
 */
export function routeFindings(answers, thresholds = THRESHOLDS) {
  const worse = noulValue(answers?.worse_for_reader);
  const discusses = noulValue(answers?.discusses_patterns);
  const signals = { worse_for_reader: worse, discusses_patterns: discusses };
  if (worse === null) {
    return { verdict: null, reason: "judge returned no usable answers", signals };
  }
  const reason = `judge: ${describe(signals)}`;
  if (discusses !== null && discusses >= thresholds.discussesPatterns) {
    return { verdict: "dismissed", reason, signals };
  }
  return {
    verdict: worse >= thresholds.worseForReader ? "confirmed" : "dismissed",
    reason,
    signals,
  };
}

export function buildRewriteQuestions() {
  return {
    meaning_preserved: {
      type: "noul",
      instructions:
        "`before` in the state is a passage that was flagged for machine-writing patterns; " +
        "`after` is its rewrite. Does `after` make the same claims as `before`: the same " +
        "facts, numbers, names, steps and commitments? Dropping filler, sales adjectives or a " +
        "restated point preserves the meaning. Asserting something `before` did not say, or " +
        "losing a fact, an instruction or a caveat, does not.",
      criteria: {
        true: "A reader of `after` learns everything of substance that `before` said, and nothing it did not.",
        false: "`after` drops a substantive claim or adds one that `before` did not make.",
      },
    },
    still_formulaic: {
      type: "noul",
      instructions:
        "Read `after` in the state on its own. Does it still read as formula prose: filler " +
        "phrases, sales adjectives, a negation set up only to be reversed, a run of short punchy " +
        "sentences, or a flagged pattern swapped for its nearest neighbour (a negation moved " +
        'into "rather than", a contrast turned into ", and")? Plain, specific technical ' +
        "writing is not formula prose.",
      criteria: {
        true: "The rewrite still leans on stock patterns a careful editor would cut.",
        false: "The rewrite is plain and specific.",
      },
    },
  };
}

export function buildRewriteState({ path, before, after } = {}) {
  return { path: String(path ?? ""), before: clip(before), after: clip(after) };
}

/**
 * Route the second judgment together with what the deterministic recheck found.
 *
 * A changed meaning outranks everything: deslop-text's first principle is that
 * every rewrite preserves the original meaning. `remainingReportable` is the
 * detector's own reading of `after` and stands whether or not Jev answered.
 */
export function routeRewrite(
  answers,
  { remainingReportable = false } = {},
  thresholds = THRESHOLDS,
) {
  const meaning = noulValue(answers?.meaning_preserved);
  const formulaic = noulValue(answers?.still_formulaic);
  const signals = { meaning_preserved: meaning, still_formulaic: formulaic };
  const judged = meaning !== null || formulaic !== null;
  const reason = judged ? `judge: ${describe(signals)}` : "judge returned no usable answers";
  if (meaning !== null && meaning < thresholds.meaningPreserved) {
    return { verdict: "meaning_changed", reason, signals, judged };
  }
  if (remainingReportable || (formulaic !== null && formulaic >= thresholds.stillFormulaic)) {
    return { verdict: "still_slop", reason, signals, judged };
  }
  return { verdict: "clean", reason, signals, judged };
}

async function ask({ state, questions, askImpl, timeoutMs, model, env, signal }) {
  return askImpl({
    state,
    questions,
    model,
    env,
    feature: FEATURE,
    signal: signal ?? AbortSignal.timeout(timeoutMs),
  });
}

function unavailable(error) {
  const message = error instanceof Error ? error.message : String(error);
  return { judged: false, verdict: null, reason: `judge unavailable: ${message}`, signals: {} };
}

/**
 * Ask System One whether flagged findings deserve a rewrite. `ask` is
 * injectable so tests never touch the network; nothing thrown escapes.
 */
export async function verifyFindings({
  path,
  text,
  findings,
  timeoutMs = VERIFY_TIMEOUT_MS,
  thresholds = THRESHOLDS,
  model,
  env,
  ask: askImpl = askSystemOne,
  signal,
} = {}) {
  try {
    const result = await ask({
      state: buildFindingsState({ path, text, findings }),
      questions: buildFindingsQuestions(),
      askImpl,
      timeoutMs,
      model,
      env,
      signal,
    });
    const routed = routeFindings(result?.answers, thresholds);
    if (routed.verdict === null) {
      return { ...routed, judged: false, reason: `judge unavailable: ${routed.reason}` };
    }
    return { ...routed, judged: true };
  } catch (error) {
    return unavailable(error);
  }
}

/**
 * Ask System One about a rewrite. With Jev unavailable the verdict still
 * comes back, decided by the deterministic recheck alone and `judged: false`.
 */
export async function verifyRewrite({
  path,
  before,
  after,
  remainingReportable = false,
  timeoutMs = VERIFY_TIMEOUT_MS,
  thresholds = THRESHOLDS,
  model,
  env,
  ask: askImpl = askSystemOne,
  signal,
} = {}) {
  let answers;
  let failure;
  try {
    const result = await ask({
      state: buildRewriteState({ path, before, after }),
      questions: buildRewriteQuestions(),
      askImpl,
      timeoutMs,
      model,
      env,
      signal,
    });
    answers = result?.answers;
  } catch (error) {
    failure = unavailable(error).reason;
  }
  const routed = routeRewrite(answers, { remainingReportable }, thresholds);
  return failure ? { ...routed, reason: failure } : routed;
}
