// handoff-rules.mjs — fixed rules for what a handoff says, in plain code.
//
// Jev scores and selects; these checks do not depend on a score, so a low one
// can never drop a rule the user set or let agent-written text pass for the user.

const CUE =
  /\b(?:never|do not|don't|dont|must not|mustn't|should not|shouldn't|not allowed|nothing is|without (?:asking|approval|permission|confirmation|checking|my )|ask (?:me )?(?:first|before)|check with me|only (?:after|if|when) i)\b/i;

// Words that name a risky action on their own. Broad stems such as `post\w*`,
// `pay\w*`, `send` and `tokens?` also match ordinary talk ("post-process",
// "payload", "send me the short version", "more tokens"), and every noisy pin
// takes a slot a real rule needs, so those need an object that makes them risky.
const RISK =
  /\b(?:force[- ]?push|default branch|(?:push(?:ing)? to|commit to) (?:main|master)|delet\w*|remov\w*|rm -rf|drop (?:table|database)|reset --hard|rewrit\w*|secrets?|credentials?|api[- ]?keys?|token|(?:access|auth|api|bearer) tokens?|passwords?|production|deploy\w*|publish\w*|releas\w*|(?:send|sent|post|posted|posting)(?: an?| the| any)? (?:e-?mails?|messages?|dms?|tweets?|comments?|reviews?)|e-?mail\w*|spend\w*|purchas\w*|buy(?:ing)? (?:anything|things)|payments?|pay(?:ing)? for|on my behalf|destructive|overwrit\w*)\b/i;

/**
 * Whether a user message states a standing safety rule: a prohibition or an
 * ask-first condition that sits next to a risky action. Deliberately narrow: a
 * "don't worry about it" or "never mind" is not a rule, and a rule pinned by
 * mistake only costs one more verbatim line.
 */
export function isStandingRule(text) {
  return typeof text === "string" && CUE.test(text) && RISK.test(text);
}

// Spaces and tabs only: `\s*` also crosses newlines, so a run of blank lines made
// every line start rescan the rest of the input (quadratic).
const SPEAKER_LABEL = /^([ \t]*(?:\[[^\]\n]*\][ \t]*)?)(user|human)[ \t]*:/gim;

/**
 * Text the agent or a tool wrote is quoted into the handoff, and a line in it
 * that opens with `User:` reads like a turn from the user: an approval the
 * user never gave. Such a label is marked as quoted, so only the sections built
 * from real user-role messages speak for the user.
 */
export function defangSpeakerLabels(text) {
  return String(text ?? "").replace(SPEAKER_LABEL, "$1(quoted by the agent) $2:");
}

/**
 * `carriedRules` trusts a line that opens with `## ` and a rules title, so text
 * the agent wrote must not be able to open one. A heading line in it gets a
 * backslash: still readable, no longer a section.
 */
export function escapeSectionHeadings(text) {
  return String(text ?? "").replace(/^##(?=[ \t])/gm, "\\##");
}

const RULES_TITLES = new Set([
  "Standing rules and constraints (verbatim)",
  "Constraints & preferences (verbatim)",
]);
/** Rules carried from earlier handoffs; past this the oldest are let go. */
export const MAX_CARRIED_RULES = 40;

const sectionsOf = (summary) =>
  String(summary ?? "")
    .split(/^(?=## )/m)
    .map((part) => {
      const [head, ...rest] = part.split("\n");
      return { part, title: head.startsWith("## ") ? head.slice(3).trim() : null, body: rest };
    });

/**
 * The rule bullets of an earlier handoff, one string each. Each compaction
 * excerpts the one before it, so a rule would fade after a few rounds; carrying
 * the bullets forward whole keeps them as the user wrote them.
 */
export function carriedRules(summary) {
  const rules = [];
  for (const { title, body } of sectionsOf(summary)) {
    if (!RULES_TITLES.has(title)) continue;
    for (const line of body) {
      if (line.startsWith("- ")) rules.push(line.slice(2));
      else if (line.startsWith("  ") && rules.length > 0)
        rules[rules.length - 1] += `\n${line.slice(2)}`;
    }
  }
  return rules;
}

/** An earlier handoff without its rules section, for the "Earlier context" excerpt. */
export function withoutRules(summary) {
  return sectionsOf(summary)
    .filter(({ title }) => !RULES_TITLES.has(title))
    .map(({ part }) => part)
    .join("")
    .trim();
}
