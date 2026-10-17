// rules.mjs — the AGENTS.md preferences that are judgement calls, as questions.
//
// check-conventions, tsc, oxlint, oxfmt, knip and fallow decide everything that
// can be decided from shape. What is left is prose: "would a senior engineer
// call this overcomplicated", "one logical change per commit". That residue is
// what a semantic lint is for.
//
// Every question is a Noul whose TRUE answer means the rule is violated, so one
// routing table covers the lot. The threshold sits beside its rule: a rule that
// misfires gets tuned where it is written, not in a global constant.

export const DEFAULT_THRESHOLD = 0.6;

const noul = (instructions, yes, no) => ({
  type: "noul",
  instructions,
  criteria: { true: yes, false: no },
});

const PREFERENCES = [
  {
    id: "overengineered",
    label: "more machinery than the problem needs",
    threshold: DEFAULT_THRESHOLD,
    question: noul(
      "Read `diff`. Would a senior engineer looking at this change say it is more " +
        "complicated than the problem requires — extra layers, indirection, configuration or " +
        "generality that this change's own callers do not need? Judge the code as written, not " +
        "what the commit intends.",
      "A simpler shape plainly does the job: a wrapper with one call site, an interface with one implementation, config for a value that is fixed today.",
      "The structure follows from the problem, even if the change is large.",
    ),
  },
  {
    id: "unrequested_abstraction",
    label: "a seam nothing calls for",
    threshold: DEFAULT_THRESHOLD,
    question: noul(
      "Read `diff`. Does it introduce an abstraction — a new module, class, interface, " +
        "generic parameter, registry or plugin point — that nothing in this change calls for? " +
        "An abstraction the diff's own callers use, or one that removes duplication, is not " +
        "unrequested.",
      "A new seam exists with one user or no user, added for a future that is not in this change.",
      "Every new abstraction is used by code in this diff, or removes existing duplication.",
    ),
  },
  {
    id: "speculative_scaffolding",
    label: "code for a requirement that does not exist",
    threshold: DEFAULT_THRESHOLD,
    question: noul(
      "Read `diff`. Does it add something for later rather than for now — an unused " +
        "option, parameter, flag, hook, placeholder module, or a branch nothing can reach? A " +
        "linter cannot see this when the value is exported or defaulted, which is why it is asked.",
      "Something is added for a future need: an unused option, an unexercised branch, a placeholder.",
      "Everything added is needed by the change as it stands.",
    ),
  },
  {
    id: "unnecessary_dependency",
    label: "reinventing something already available",
    threshold: DEFAULT_THRESHOLD,
    question: noul(
      "Read `diff`. Does it add a package, vendored block or helper for something the " +
        "standard library, the platform or an installed dependency already covers? Judge only " +
        "what the diff adds.",
      "A dependency is added for something already available: node: core, a native platform feature, or an installed package.",
      "Nothing new is added, or what is added has no existing equivalent.",
    ),
  },
  {
    id: "scope_creep",
    label: "changes the task did not ask for",
    threshold: 0.65,
    requires: "task",
    question: noul(
      "Read `diff` and `task`. Does the diff change files or behaviour that " +
        "`task` does not mention or imply? Unrelated formatting, renames and drive-by " +
        "fixes count; a change the task needs in order to work does not.",
      "Part of the diff is unrelated to the task and could be committed separately.",
      "Everything in the diff serves the task.",
    ),
  },
  {
    id: "weak_tests",
    label: "tests that would pass without the change",
    threshold: DEFAULT_THRESHOLD,
    requires: "tests",
    question: noul(
      "Read `diff`. For the tests it adds or changes: would they still pass if the " +
        "behaviour the diff introduces were broken? Tests that assert a constant, assert that a " +
        "mock was called, or restate the implementation do not count.",
      "An added test would pass with the change reverted, or asserts no observable behaviour.",
      "The added tests exercise the new behaviour and would fail without it.",
    ),
  },
];

const COMMIT_RULES = [
  {
    id: "message_matches_diff",
    label: "subject describes something the diff does not do",
    threshold: 0.6,
    requires: "message",
    question: noul(
      "Read `message` and `diff`. Does the subject line describe what the diff " +
        "actually changes, rather than what was intended, attempted or planned? A subject about " +
        "a different file, a different behaviour, or a claim the diff does not support is a mismatch.",
      "The subject names a change the diff does not make, or is too vague to describe any particular change.",
      "The subject describes the change the diff makes.",
    ),
  },
  {
    id: "single_concern",
    label: "more than one logical change",
    threshold: 0.6,
    requires: "message",
    question: noul(
      "Read `message` and `diff`. Is this one logical change that a reviewer would " +
        "accept or reject as a unit? A fix plus a refactor, a feature plus a rename, or two " +
        "unrelated modules changed together are separate commits.",
      "Unrelated changes are mixed in: one could not be reverted without the other.",
      "The diff is one change, however many lines it touches.",
    ),
  },
  {
    id: "commit_type_correct",
    label: "conventional-commit type does not match the change",
    threshold: 0.65,
    requires: "message",
    question: noul(
      "Read `message` and `diff`. Does the conventional-commit type match the " +
        "change: fix for a user-visible bug, refactor for no behaviour change, feat for new " +
        "behaviour, docs/test/chore/build/ci for their own scope? A behaviour change typed as " +
        "refactor, or a wording fix typed as feat, is wrong.",
      "The type names a different kind of change than the diff makes.",
      "The type matches the kind of change the diff makes.",
    ),
  },
];

const ALL = [...PREFERENCES, ...COMMIT_RULES];

/**
 * The questions this change earns. A rule that needs a commit message, a task
 * statement or test files is left out rather than asked against null state: a
 * question answered from nothing comes back as a confident "no".
 */
export function buildQuestionSet({ message, task, hasTests } = {}) {
  const facts = { message: Boolean(message), task: Boolean(task), tests: hasTests === true };
  const questions = {};
  for (const rule of ALL) {
    if (rule.requires && !facts[rule.requires]) continue;
    questions[rule.id] = rule.question;
  }
  return questions;
}

/** Rule metadata by id, for formatting a finding without trusting the model. */
export const RULES_BY_ID = new Map(ALL.map((rule) => [rule.id, rule]));
