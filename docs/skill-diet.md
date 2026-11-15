# Keeping skills lean

A skill is read in full every time it loads, so each line costs tokens in every
session that uses it. This is the checklist for the skills in `.agents/skills/`
and the project recipe in `.pi/verify/`. The idea comes from the
[skill-diet](https://github.com/nicobailon/skill-diet/tree/b93e14766ef327e2ff1b1d44f93027fb654e880b)
project; the wording and the rules here are ours, and nothing was copied.

## Checklist

1. **Put a fact where the agent meets it anyway.** In order of preference: the
   tool's own `--help` or error message, the repository's docs or code, and only
   then the skill. Keep in the skill what none of those can carry.
2. **Point, don't paste.** Say "run `tool --help`" or link the docs instead of
   copying flag lists, schemas, option tables or usage text. A copy goes stale;
   the pointer does not.
3. **Give each fact one home.** If the same reference text sits in a skill, a
   doc and a prompt, keep one and link the others.
4. **Keep only what the agent cannot find itself.** That means decisions, the
   order of steps, traps learned the hard way and this repo's conventions. Cut
   explanations of things the tool already says or a competent agent already
   knows.
5. **Fix the tool before lengthening the skill.** If a skill exists to warn about
   a confusing error, a clearer error message is the cheaper fix.
6. **Leave history out.** Run transcripts, dated "last run" logs and how a bug
   was found belong in git, CI or an issue, not in text that loads every time.
7. **Never trim the instructions.** A diet removes duplication and bloat; it does
   not change what the skill tells the agent to do. Read the diff as removals
   only, keep the frontmatter `description` (it is what picks the skill), and
   rerun `npm run check`.

## Measuring

Count bytes before and after (`wc -c SKILL.md`) and report both numbers per
skill. Report what was measured here; do not assume a saving from anywhere else.
