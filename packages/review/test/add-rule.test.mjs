import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  addUserRule,
  analyzeComparisons,
  buildRuleCompareRequest,
  formatCompareReport,
  ruleFilePath,
} from "../add-rule.mjs";

const temporaryDirectories = [];

after(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "pi-review-add-rule-"));
  temporaryDirectories.push(dir);
  return dir;
}

function writeRule(dir, filename, body) {
  const rulesDir = join(dir, ".agents", "rules");
  mkdirSync(rulesDir, { recursive: true });
  writeFileSync(join(rulesDir, filename), body);
}

const PROPOSED = {
  name: "no-console-log",
  subject: "debug logging left in production paths",
  requirement: "Do not add console.log calls outside test files",
  purpose: "Keep runtime output quiet in shipped code",
};

const EXISTING_USER = `---
name: no-drive-by-format
subject: unrelated formatting mixed into a functional change
requirement: Do not reformat or reorder code outside the lines the task touches
purpose: Keep review focused on what changed for a reason
---
`;

function distinctAnswers(ruleIds) {
  return Object.fromEntries(
    ruleIds.map((id) => [`cmp_${id}`, { type: "choice", choice: "distinct" }]),
  );
}

test("analyzeComparisons rejects covered or conflict", () => {
  const result = analyzeComparisons(
    {
      cmp_overengineered: { type: "choice", choice: "distinct" },
      "cmp_no-drive-by-format": { type: "choice", choice: "covered" },
    },
    ["overengineered", "no-drive-by-format"],
  );
  assert.equal(result.ok, true);
  assert.equal(result.canWrite, false);
  assert.deepEqual(
    result.blocking.map((entry) => entry.id),
    ["no-drive-by-format"],
  );
});

test("analyzeComparisons rejects unusable answers", () => {
  const result = analyzeComparisons(
    {
      cmp_overengineered: { type: "choice", choice: "" },
    },
    ["overengineered"],
  );
  assert.equal(result.ok, false);
});

test("buildRuleCompareRequest validates state and questions", () => {
  const dir = tempDir();
  writeRule(dir, "no-drive-by-format.md", EXISTING_USER);
  const { state, questions } = buildRuleCompareRequest(dir, PROPOSED, "");
  assert.ok(state.proposed.name);
  assert.ok(state.existing.length > 0);
  assert.ok("cmp_overengineered" in questions);
  assert.ok("cmp_no-drive-by-format" in questions);
});

test("distinct, approved, writes the rule file", async () => {
  const dir = tempDir();
  writeRule(dir, "no-drive-by-format.md", EXISTING_USER);
  const { questions } = buildRuleCompareRequest(dir, PROPOSED, "Examples go in the body.");
  const ruleIds = Object.keys(questions).map((key) => key.slice(4));
  const target = ruleFilePath(dir, PROPOSED.name);
  const result = await addUserRule({
    repoRoot: dir,
    fields: PROPOSED,
    body: "Examples go in the body.",
    ask: async () => ({ answers: distinctAnswers(ruleIds) }),
    approve: async () => true,
  });
  assert.equal(result.written, true);
  assert.ok(existsSync(target));
  const text = readFileSync(target, "utf8");
  assert.match(text, /^---\nname: no-console-log\n/);
  assert.match(text, /Examples go in the body\./);
});

test("covered or conflict shown and rejected writes nothing", async () => {
  const dir = tempDir();
  const { questions } = buildRuleCompareRequest(dir, PROPOSED, "");
  const ruleIds = Object.keys(questions).map((key) => key.slice(4));
  const answers = distinctAnswers(ruleIds);
  answers[`cmp_${ruleIds[0]}`] = { type: "choice", choice: "conflict" };
  const target = ruleFilePath(dir, PROPOSED.name);
  const result = await addUserRule({
    repoRoot: dir,
    fields: PROPOSED,
    ask: async () => ({ answers }),
    approve: async () => true,
  });
  assert.equal(result.written, false);
  assert.equal(result.reason, "blocking-relation");
  assert.equal(existsSync(target), false);
  const report = formatCompareReport(result.analysis);
  assert.match(report, /conflict/i);
});

test("unusable Jev answer writes nothing", async () => {
  const dir = tempDir();
  const result = await addUserRule({
    repoRoot: dir,
    fields: PROPOSED,
    ask: async () => ({
      answers: { cmp_overengineered: { type: "choice", choice: "not-a-relation" } },
    }),
    approve: async () => true,
  });
  assert.equal(result.written, false);
  assert.equal(result.reason, "unusable-answer");
});

test("existing rule file name is refused", async () => {
  const dir = tempDir();
  writeRule(
    dir,
    "no-console-log.md",
    `---
name: no-console-log
subject: old
requirement: old
purpose: old
---
`,
  );
  const result = await addUserRule({
    repoRoot: dir,
    fields: PROPOSED,
    ask: async () => {
      throw new Error("Jev should not run when the file exists");
    },
    approve: async () => true,
  });
  assert.equal(result.written, false);
  assert.equal(result.reason, "exists");
});
