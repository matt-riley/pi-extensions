import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { discoverSkills, rankSkills } from "../packages/skill-select/library.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const skillRoot = fileURLToPath(new URL("../.agents/skills", import.meta.url));

test("owned workflow skills have portable metadata and package registration", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.deepEqual(manifest.pi.skills, ["./.agents/skills"]);
  const skills = await discoverSkills({ roots: [skillRoot] });
  assert.deepEqual(skills.map((skill) => skill.name).sort(), [
    "implementation-review",
    "interface-design",
    "test-driven-development",
  ]);
  for (const skill of skills) {
    assert.match(skill.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(skill.description.length > 0 && skill.description.length <= 1024, skill.name);
    assert.ok(skill.path.endsWith("/" + skill.name + "/SKILL.md"), skill.path);
    const body = await readFile(skill.path, "utf8");
    assert.ok(body.split("\n").length < 100, "compact workflows, not a framework");
    assert.ok(body.length > 500, "not empty instructions");
  }
});

test("realistic tasks route to owned workflows offline", async () => {
  const skills = await discoverSkills({ roots: [skillRoot] });
  assert.equal(skills.length, 3, "do not pass by testing an empty catalogue");
  const cases = [
    ["Review this PR for correctness and security regressions", "implementation-review"],
    ["Check the staged diff for actionable bugs", "implementation-review"],
    ["Write regression tests for the retry bug", "test-driven-development"],
    ["Implement a feature one tested vertical slice at a time", "test-driven-development"],
    ["Refactor this module boundary without changing behavior", "interface-design"],
    ["Design a smaller public interface for the cache", "interface-design"],
  ];
  for (const [query, expected] of cases)
    assert.equal(rankSkills(skills, query, { limit: 1 })[0]?.name, expected, query);
  assert.deepEqual(rankSkills(skills, "watercolor landscape"), []);
});

test("script-backed prompts discover their installation rather than assuming a clone path", async () => {
  const scripts = {
    cost: ["context-report"],
    mine: ["mine-transcripts", "promote-corrections"],
    recall: ["mine-transcripts"],
    retro: ["memory-check"],
    triage: ["ci-triage"],
  };
  for (const [name, names] of Object.entries(scripts)) {
    const text = await readFile(root + "prompts/" + name + ".md", "utf8");
    assert.doesNotMatch(text, /~\/\.pi\/agent\/extensions\/pi-extensions/, name);
    assert.ok(text.includes("`pi list`"), name);
    assert.ok(text.includes("PI_CODING_AGENT_DIR"), name);
    assert.ok(text.includes("ambiguous"), name);
    for (const script of names) {
      assert.ok(text.includes('node "<collection-root>/scripts/' + script + '.mjs"'), name);
      await readFile(root + "scripts/" + script + ".mjs", "utf8");
    }
  }
});

test("every owned workflow is used by a prompt", async () => {
  const prompts = {
    "implementation-review": ["review", "pr"],
    "test-driven-development": ["test"],
    "interface-design": ["design", "refactor"],
  };
  for (const [skill, names] of Object.entries(prompts))
    for (const name of names) {
      const text = await readFile(root + "prompts/" + name + ".md", "utf8");
      assert.ok(text.includes("the `" + skill + "` skill"), name);
    }
});

test("the restate prompt asks for a plain restatement and forbids acting", async () => {
  const text = await readFile(root + "prompts/restate.md", "utf8");
  assert.match(text, /^---\n(?:[\s\S]*?\n)?description: /);
  assert.match(text, /restate in your own words/i);
  assert.match(text, /\bgoal\b/i);
  assert.match(text, /\bproblem\b/i);
  assert.match(text, /constraint/i);
  assert.match(text, /assumption/i);
  assert.match(text, /open questions/i);
  assert.match(text, /Do not edit files or run tools/);
  assert.match(text, /\$@/, "the brief passed as arguments must reach the model");
  assert.doesNotMatch(text, /skill_select|the `\w+` skill/);
});

test("the garden prompt proposes durable lint rules while keeping its scan read-only and approval-gated", async () => {
  const text = await readFile(root + "prompts/garden.md", "utf8");
  for (const sentence of [
    "Do not fix findings during this scan.",
    "At 3 distinct occurrences, draft the exact preventive change and ask for approval.",
    "Prefer an existing lint rule for mechanically checkable smells; if none covers the pattern, propose writing a custom rule in the repository’s native tooling.",
    "Keep judgment-only concerns as review guidance rather than unreliable lint.",
    "Include the detection boundary, a failing example, legitimate passing examples and false-positive risks in a proposed rule.",
    "Use parser and declaration/type information for comment rules; preserve useful documentation, including Go documentation comments, rationale, licenses and directives.",
    "After approval, implement the rule with regression tests and wire it into the normal check command and existing CI gate.",
    "Run it against the proposal's failing and passing examples without lowering thresholds or adding blanket suppressions.",
  ])
    assert.ok(text.includes(sentence), sentence);
});
