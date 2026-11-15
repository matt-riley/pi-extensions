// plan-shape.mjs: what a plan must contain before plan_mode_complete accepts it.
//
// One rule so far: a plan says how it will be checked. The plan check (an
// optional TypeSafe read of each step) can only point at a missing check; this
// refuses a plan that names none, with no key and no model.

const HEADING = /^(#{1,6})\s+(.*)$/;
const VERIFICATION_TITLE = /\b(?:verif\w*|testing|tests?|test plan|acceptance|validat\w*)\b/i;
const MIN_BODY_CHARS = 20;

/** The text under each heading, up to the next heading, with the heading's own text. */
function sections(plan) {
  const out = [];
  for (const line of String(plan ?? "").split(/\r?\n/)) {
    const heading = HEADING.exec(line);
    if (heading) out.push({ title: heading[2], body: [] });
    else out.at(-1)?.body.push(line);
  }
  return out.map(({ title, body }) => ({ title, body: body.join("\n").trim() }));
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
