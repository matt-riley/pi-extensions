import { test } from "node:test";
import assert from "node:assert/strict";

import { planAgentsFile } from "../scaffold.mjs";

const scripts = { build: "tsc", test: "node --test" };
const SCOPE = "Guidance for coding agents working in this directory and below.";

test("creates a minimal file when there are no scripts to document", () => {
  const plan = planAgentsFile(null, { scripts: {} });
  assert.equal(plan.action, "create");
  assert.equal(plan.content, `# AGENTS.md\n\n${SCOPE}\n`);
  assert.doesNotMatch(plan.content, /## Commands/);
});

test("a new file lists the package.json scripts as commands", () => {
  const plan = planAgentsFile(null, { scripts });
  assert.equal(plan.action, "create");
  assert.match(plan.content, /## Commands\n\n- `npm run build`\n- `npm run test`\n$/);
  assert.equal(plan.commandCount, 2);
});

test("an update keeps every existing byte before the appended section", () => {
  const existing = "# Rules\n\n- Never force-push.\n- Ask before deploying.\n";
  const plan = planAgentsFile(existing, { scripts });
  assert.equal(plan.action, "update");
  assert.ok(plan.content.startsWith(existing));
  assert.equal(plan.content, existing + "\n## Commands\n\n- `npm run build`\n- `npm run test`\n");
  assert.doesNotMatch(plan.content, /\n{3}/);
});

test("the separator adapts to the file's ending and never glues or triples lines", () => {
  const cases = [
    ["Rules", "Rules\n\n## Commands"],
    ["Rules\n", "Rules\n\n## Commands"],
    ["Rules\n\n", "Rules\n\n## Commands"],
  ];
  for (const [existing, expected] of cases) {
    const plan = planAgentsFile(existing, { scripts });
    assert.equal(plan.action, "update");
    assert.ok(plan.content.startsWith(expected), JSON.stringify(existing));
    assert.doesNotMatch(plan.content, /\n{3}/, JSON.stringify(existing));
  }
});

test("an existing Commands heading wins over a generated one", () => {
  const existing = "# Rules\n\n## Commands\n\n- `make test`\n";
  const plan = planAgentsFile(existing, { scripts });
  assert.deepEqual(plan, { action: "unchanged", content: existing, commandCount: 2 });
});

test("any heading that starts with 'command' counts, and prose about commands does not", () => {
  for (const heading of ["## Commands", "### commands", "## Commands and tests"]) {
    assert.equal(planAgentsFile(`# Rules\n\n${heading}\n\n- x\n`, { scripts }).action, "unchanged");
  }
  const prose = "# Rules\n\nRun commands from the repository root.\n";
  assert.equal(planAgentsFile(prose, { scripts }).action, "update");
});

test("a whitespace-only file is treated as missing, not as guidance to keep", () => {
  const plan = planAgentsFile("\n  \n", { scripts });
  assert.equal(plan.action, "create");
  assert.match(plan.content, /^# AGENTS.md/);
});

test("non-string or unnamed scripts are not commands", () => {
  const plan = planAgentsFile(null, { scripts: { test: 42, "": "true", build: "tsc" } });
  assert.equal(plan.action, "create");
  assert.equal(plan.commandCount, 1);
  assert.match(plan.content, /- `npm run build`/);
  assert.doesNotMatch(plan.content, /npm run test/);
  assert.equal(planAgentsFile(null, { scripts: ["npm test"] }).commandCount, 0);
});

test("planning the result again changes nothing", () => {
  for (const existing of [null, "# Rules\n", "# Rules\n\n## Commands\n"]) {
    const first = planAgentsFile(existing, { scripts });
    const second = planAgentsFile(first.content, { scripts });
    assert.equal(second.action, "unchanged");
    assert.equal(second.content, first.content);
  }
});
