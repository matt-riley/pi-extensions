// rules.mjs — the AGENTS.md preferences that are judgement calls, as questions.
//
// Repositories may add judgement rules under `.agents/rules/<name>.md`; each
// file becomes one more yes/no question in the same shape as the built-ins.
//
// check-conventions, tsc, oxlint, oxfmt, knip and fallow decide everything that
// can be decided from shape. What is left is prose: "would a senior engineer
// call this overcomplicated", "one logical change per commit". That residue is
// what a semantic lint is for.
//
// Every question is a Noul whose TRUE answer means the rule is violated, so one
// routing table covers the lot. The threshold sits beside its rule: a rule that
// misfires gets tuned where it is written, not in a global constant.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_THRESHOLD = 0.6;

const RULES_DIR = ".agents/rules";
const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_NAME_LEN = 80;
const APPLICABILITY = new Set(["message", "task", "tests"]);
const BUILTIN_IDS = new Set();

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
    id: "narrating_comment",
    label: "a comment that restates the code or the change",
    threshold: DEFAULT_THRESHOLD,
    question: noul(
      "Read `diff`. Do the comment lines it adds say what the next line already says, " +
        'or narrate the edit itself ("now handles X", "changed to Y", "added for the Z ticket")? ' +
        "A comment that records a reason, a constraint or a trap the code cannot show is not " +
        "narration. Judge only comments the diff adds.",
      "An added comment restates the code beside it or describes the change rather than the code.",
      "Added comments explain why, or the diff adds none.",
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
for (const rule of ALL) BUILTIN_IDS.add(rule.id);

function unquoteScalar(raw) {
  const text = String(raw ?? "").trim();
  if (
    (text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
    (text.startsWith("'") && text.endsWith("'") && text.length >= 2)
  ) {
    return text.slice(1, -1);
  }
  return text;
}

/** A small YAML subset for rule frontmatter: plain scalars only. */
function parseRuleFrontmatter(text) {
  const normalized = String(text ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const keyMatch = /^([A-Za-z0-9_-]+):\s*(.*?)\s*$/.exec(line);
    if (!keyMatch) continue;
    fields[keyMatch[1]] = unquoteScalar(keyMatch[2]);
  }
  return { fields, body: match[2] ?? "" };
}

function validateUserRule(fields) {
  const missing = ["name", "subject", "requirement", "purpose"].filter(
    (key) => !String(fields[key] ?? "").trim(),
  );
  if (missing.length > 0) {
    return `missing frontmatter key(s): ${missing.join(", ")}`;
  }
  const name = String(fields.name).trim();
  if (name.length > MAX_NAME_LEN) {
    return `name is longer than ${MAX_NAME_LEN} characters`;
  }
  if (!NAME_PATTERN.test(name)) {
    return "name must be kebab-case";
  }
  const applicability = String(fields.applicability ?? "").trim();
  if (applicability && !APPLICABILITY.has(applicability)) {
    return `applicability must be message, task, or tests (got ${applicability})`;
  }
  if (fields["enforced-by"] !== undefined) {
    // Reserved for a future gate; ignored until wired up.
  }
  return null;
}

function userRuleFromFile(fields, body) {
  const name = String(fields.name).trim();
  const subject = String(fields.subject).trim();
  const requirement = String(fields.requirement).trim();
  const purpose = String(fields.purpose).trim();
  const applicability = String(fields.applicability ?? "").trim();
  const context = String(body ?? "").trim();
  const instructions = [
    "Read `diff`.",
    requirement,
    `Purpose: ${purpose}.`,
    context ? `Context:\n${context}` : "",
    "Judge only what the diff changes.",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    id: name,
    label: subject,
    threshold: DEFAULT_THRESHOLD,
    requires: applicability || undefined,
    question: noul(instructions, subject, "The change satisfies the requirement for this rule."),
  };
}

/**
 * Load judgement rules from `.agents/rules/*.md` under `repoRoot`. Missing
 * directory means none. Malformed files are skipped; `warn` receives a short
 * message naming the file. Built-in ids win on a name clash.
 */
export function loadUserRules(repoRoot, warn = () => {}) {
  const dir = join(String(repoRoot ?? ""), RULES_DIR);
  if (!existsSync(dir)) return [];
  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    warn(`could not read ${RULES_DIR}`);
    return [];
  }
  const loaded = [];
  for (const filename of names) {
    const filePath = join(dir, filename);
    let content;
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      warn(`skip ${filename}: could not read file`);
      continue;
    }
    const parsed = parseRuleFrontmatter(content);
    if (!parsed) {
      warn(`skip ${filename}: no YAML frontmatter block`);
      continue;
    }
    const problem = validateUserRule(parsed.fields);
    if (problem) {
      warn(`skip ${filename}: ${problem}`);
      continue;
    }
    const id = String(parsed.fields.name).trim();
    if (BUILTIN_IDS.has(id)) {
      warn(`skip ${filename}: built-in rule "${id}" already defines this id`);
      continue;
    }
    loaded.push(userRuleFromFile(parsed.fields, parsed.body));
  }
  return loaded;
}

function mergedRules(repoRoot, warn) {
  if (!repoRoot) return ALL;
  return [...ALL, ...loadUserRules(repoRoot, warn)];
}

/**
 * The questions this change earns. A rule that needs a commit message, a task
 * statement or test files is left out rather than asked against null state: a
 * question answered from nothing comes back as a confident "no".
 */
export function buildQuestionSet({ message, task, hasTests, cwd, warn } = {}) {
  const facts = { message: Boolean(message), task: Boolean(task), tests: hasTests === true };
  const questions = {};
  for (const rule of mergedRules(cwd, warn)) {
    if (rule.requires && !facts[rule.requires]) continue;
    questions[rule.id] = rule.question;
  }
  return questions;
}

/** Rule metadata for a repo root (built-ins plus loaded user rules). */
export function rulesByIdForRepo(repoRoot, warn = () => {}) {
  return new Map(mergedRules(repoRoot, warn).map((rule) => [rule.id, rule]));
}
