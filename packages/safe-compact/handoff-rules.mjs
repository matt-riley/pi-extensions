// handoff-rules.mjs — fixed rules for what a handoff says, in plain code.
//
// Jev scores and selects; these checks do not depend on a score, so a low one
// can never drop a rule the user set or let agent-written text pass for the user.

const CUE =
  /\b(?:never|do not|don't|dont|must not|mustn't|should not|shouldn't|not allowed|nothing is|without (?:asking|approval|permission|confirmation|checking|my )|ask (?:me )?(?:first|before)|check with me|only (?:after|if|when) i)\b/i;

const RISK =
  /\b(?:force[- ]?push|default branch|(?:push(?:ing)? to|commit to) (?:main|master)|delet\w*|remov\w*|rm -rf|drop (?:table|database)|reset --hard|rewrit\w*|secrets?|credentials?|api[- ]?keys?|tokens?|passwords?|production|prod|deploy\w*|publish\w*|releas\w*|send|sent|post\w*|e-?mail\w*|spend\w*|purchas\w*|buy|pay\w*|on my behalf|destructive|overwrit\w*)\b/i;

/**
 * Whether a user message states a standing safety rule: a prohibition or an
 * ask-first condition that sits next to a risky action. Deliberately narrow: a
 * "don't worry about it" or "never mind" is not a rule, and a rule pinned by
 * mistake only costs one more verbatim line.
 */
export function isStandingRule(text) {
  return typeof text === "string" && CUE.test(text) && RISK.test(text);
}

const SPEAKER_LABEL = /^(\s*(?:\[[^\]\n]*\]\s*)?)(user|human)\s*:/gim;

/**
 * Text the agent or a tool wrote is quoted into the handoff, and a line in it
 * that opens with `User:` reads like a turn from the user: an approval the
 * user never gave. Such a label is marked as quoted, so only the sections built
 * from real user-role messages speak for the user.
 */
export function defangSpeakerLabels(text) {
  return String(text ?? "").replace(SPEAKER_LABEL, "$1(quoted by the agent) $2:");
}
