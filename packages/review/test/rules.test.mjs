import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { formatLint, lintChange } from "../lint.mjs";
import { buildQuestionSet, loadUserRules, resolveRepoRules } from "../rules.mjs";

const DIFF = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n";

const temporaryDirectories = [];

after(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "pi-review-rules-"));
  temporaryDirectories.push(dir);
  return dir;
}

function writeRule(dir, filename, body) {
  const rulesDir = join(dir, ".agents", "rules");
  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(join(rulesDir, filename), body);
}

const VALID_RULE = `---
name: no-drive-by-format
subject: unrelated formatting mixed into a functional change
requirement: Do not reformat or reorder code outside the lines the task touches
purpose: Keep review focused on what changed for a reason
---
A whole-file prettier pass on a one-line fix is a violation.
`;

test("missing .agents/rules directory adds no extra rules", () => {
  const dir = tempDir();
  const warnings = [];
  assert.deepEqual(
    loadUserRules(dir, (message) => warnings.push(message)),
    [],
  );
  assert.deepEqual(warnings, []);
  assert.deepEqual(Object.keys(buildQuestionSet({ rules: resolveRepoRules(dir).rules })).sort(), [
    "narrating_comment",
    "overengineered",
    "speculative_scaffolding",
    "unnecessary_dependency",
    "unrequested_abstraction",
  ]);
});

test("a valid user rule becomes another yes/no question", () => {
  const dir = tempDir();
  writeRule(dir, "no-drive-by-format.md", VALID_RULE);
  const warnings = [];
  const loaded = loadUserRules(dir, (message) => warnings.push(message));
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].id, "no-drive-by-format");
  assert.equal(loaded[0].label, "unrelated formatting mixed into a functional change");
  assert.deepEqual(warnings, []);
  const questions = buildQuestionSet({ rules: resolveRepoRules(dir).rules });
  assert.ok("no-drive-by-format" in questions);
  const question = questions["no-drive-by-format"];
  assert.equal(question.type, "noul");
  assert.match(question.instructions, /Do not reformat or reorder code/);
  assert.match(question.instructions, /diff/);
});

test("a malformed rule file is skipped with a warning naming the file", () => {
  const dir = tempDir();
  writeRule(dir, "broken.md", "not frontmatter at all\n");
  writeRule(dir, "incomplete.md", "---\nname: incomplete\n---\n");
  const warnings = [];
  const loaded = loadUserRules(dir, (message) => warnings.push(message));
  assert.deepEqual(loaded, []);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /broken\.md/);
  assert.match(warnings[1], /incomplete\.md/);
});

test("built-in rule ids win when a user rule reuses a name", () => {
  const dir = tempDir();
  writeRule(
    dir,
    "overengineered.md",
    `---
name: overengineered
subject: custom subject that should not load
requirement: Custom requirement
purpose: Custom purpose
---
`,
  );
  const warnings = [];
  const loaded = loadUserRules(dir, (message) => warnings.push(message));
  assert.deepEqual(loaded, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /overengineered\.md/);
  assert.match(warnings[0], /built-in/i);
  const questions = buildQuestionSet({ rules: resolveRepoRules(dir).rules });
  assert.ok("overengineered" in questions);
  assert.match(questions.overengineered.instructions, /senior engineer/);
});

test("applicability gates a user rule the same way as built-in requires", () => {
  const dir = tempDir();
  writeRule(
    dir,
    "message-only.md",
    `---
name: message-only
subject: subject line must mention the package
requirement: The commit subject names the package directory being changed
purpose: Make git log scannable by area
applicability: message
---
`,
  );
  const { rules } = resolveRepoRules(dir);
  assert.ok(!("message-only" in buildQuestionSet({ rules })));
  assert.ok("message-only" in buildQuestionSet({ rules, message: "fix(review): x" }));
});

const ENFORCED_STUB_RULE = {
  id: "stub-enforced",
  label: "mechanically covered smell",
  threshold: 0.6,
  enforcedBy: "oxlint:local/stub-rule",
  question: {
    type: "noul",
    instructions: "stub",
    criteria: { true: "yes", false: "no" },
  },
};

test("lintChange with no applicable rules is not judged", async () => {
  const result = await lintChange({
    diff: DIFF,
    rules: [],
    ask: async () => {
      throw new Error("should not ask Jev");
    },
  });
  assert.equal(result.judged, false);
  assert.equal(result.reason, "no rules apply to this change");
  assert.equal(result.enforcedRules.length, 0);
  const text = formatLint(result);
  assert.match(text, /Not judged: no rules apply to this change/);
  assert.doesNotMatch(text, /No findings above threshold/);
});

test("lintChange with only enforced rules is not judged and names native lint", async () => {
  const result = await lintChange({
    diff: DIFF,
    rules: [ENFORCED_STUB_RULE],
    ask: async () => {
      throw new Error("should not ask Jev");
    },
  });
  assert.equal(result.judged, false);
  assert.equal(result.reason, "every applicable rule is enforced by native lint");
  assert.equal(result.enforcedRules.length, 1);
  const text = formatLint(result);
  assert.match(text, /enforced-by: stub-enforced — oxlint:local\/stub-rule/);
  assert.match(text, /Not judged: every applicable rule is enforced by native lint/);
  assert.doesNotMatch(text, /No findings above threshold/);
});

test("enforced-by omits the rule from questions and formatLint lists coverage", async () => {
  const dir = tempDir();
  writeRule(
    dir,
    "native-format.md",
    `---
name: native-format
subject: unrelated formatting mixed into a functional change
requirement: Do not reformat or reorder code outside the lines the task touches
purpose: Keep review focused on what changed for a reason
enforced-by: oxlint:local/no-drive-by-format
---
`,
  );
  const warnings = [];
  const loaded = loadUserRules(dir, (message) => warnings.push(message));
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].enforcedBy, "oxlint:local/no-drive-by-format");
  assert.deepEqual(warnings, []);
  const { rules } = resolveRepoRules(dir);
  const questionSet = buildQuestionSet({ rules });
  assert.ok(!("native-format" in questionSet));
  let askedIds;
  const result = await lintChange({
    diff: DIFF,
    cwd: dir,
    ask: async ({ questions: asked }) => {
      askedIds = Object.keys(asked);
      return {
        model: "test",
        usage: null,
        answers: { overengineered: { type: "noul", noul: 0.1 } },
      };
    },
  });
  assert.ok(!askedIds.includes("native-format"));
  assert.equal(result.enforcedRules.length, 1);
  assert.equal(result.enforcedRules[0].id, "native-format");
  assert.equal(result.enforcedRules[0].enforcedBy, "oxlint:local/no-drive-by-format");
  const text = formatLint(result);
  assert.match(text, /enforced-by: native-format/);
  assert.match(text, /oxlint:local\/no-drive-by-format/);
});

test("invalid enforced-by skips the file with a warning", () => {
  const dir = tempDir();
  writeRule(
    dir,
    "bad-enforced.md",
    `---
name: bad-enforced
subject: bad enforced-by value
requirement: Something
purpose: Testing
enforced-by: not-a-valid-pair
---
`,
  );
  const warnings = [];
  const loaded = loadUserRules(dir, (message) => warnings.push(message));
  assert.deepEqual(loaded, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /bad-enforced\.md/);
  assert.match(warnings[0], /enforced-by/i);
});

test("a user rule without enforced-by still becomes a question", () => {
  const dir = tempDir();
  writeRule(dir, "no-drive-by-format.md", VALID_RULE);
  const { rules } = resolveRepoRules(dir);
  assert.ok("no-drive-by-format" in buildQuestionSet({ rules }));
});

test("lintChange returns skipped rule warnings and formatLint prints them", async () => {
  const dir = tempDir();
  writeRule(dir, "broken.md", "no frontmatter\n");
  const result = await lintChange({
    diff: DIFF,
    cwd: dir,
    ask: async () => ({
      model: "test",
      usage: null,
      answers: { overengineered: { type: "noul", noul: 0.1 } },
    }),
  });
  assert.equal(result.skippedRules.length, 1);
  assert.match(result.skippedRules[0], /broken\.md/);
  const text = formatLint(result);
  assert.match(text, /skip broken\.md:/);
});
