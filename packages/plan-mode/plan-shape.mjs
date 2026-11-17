// plan-shape.mjs: what a plan must contain before plan_mode_complete accepts it.
//
// One rule so far: a plan says how it will be checked. The plan check (an
// optional TypeSafe read of each step) can only point at a missing check; this
// refuses a plan that names none, with no key and no model.

const HEADING = /^(#{1,6})\s+(.*)$/;
const VERIFICATION_TITLE = /\b(?:verif\w*|testing|tests?|test plan|acceptance|validat\w*)\b/i;
const MIN_BODY_CHARS = 20;

const FENCE = /^\s*(`{3,}|~{3,})/;

/**
 * Each heading with the text under it, up to the next heading at the same or a
 * higher level, so a section owns its subsections. A line inside a fenced code
 * block is text, never a heading: `# comment` in a bash block is not one.
 */
function sections(plan) {
  const lines = String(plan ?? "").split(/\r?\n/);
  const headings = [];
  let fence = null;
  lines.forEach((line, index) => {
    const marker = FENCE.exec(line)?.[1];
    if (marker) {
      if (fence === null) fence = marker[0];
      else if (fence === marker[0]) fence = null;
    } else if (fence === null) {
      const heading = HEADING.exec(line);
      if (heading) headings.push({ index, level: heading[1].length, title: heading[2] });
    }
  });
  return headings.map(({ index, level, title }, at) => {
    const end = headings.slice(at + 1).find((next) => next.level <= level)?.index ?? lines.length;
    return {
      title,
      body: lines
        .slice(index + 1, end)
        .join("\n")
        .trim(),
    };
  });
}

/** Why a plan cannot be accepted, or null. */
export function planProblem(plan) {
  const found = sections(plan).some(
    ({ title, body }) => VERIFICATION_TITLE.test(title) && body.length >= MIN_BODY_CHARS,
  );
  if (found) return null;
  return (
    "the plan has no verification section. Add a '## Verification' section that says how each change " +
    "will be checked end to end: the command to run and the behaviour to observe. " +
    "Then call plan_mode_complete again."
  );
}
