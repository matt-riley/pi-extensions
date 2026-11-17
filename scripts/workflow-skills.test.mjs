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
    "arena",
    "implementation-review",
    "interface-design",
    "interrogate",
    "swarm",
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
  assert.equal(skills.length, 6, "do not pass by testing an empty catalogue");
  const cases = [
    ["Review this PR for correctness and security regressions", "implementation-review"],
    ["Check the staged diff for actionable bugs", "implementation-review"],
    ["Write regression tests for the retry bug", "test-driven-development"],
    ["Implement a feature one tested vertical slice at a time", "test-driven-development"],
    ["Refactor this module boundary without changing behavior", "interface-design"],
    ["Design a smaller public interface for the cache", "interface-design"],
    ["Interrogate this change and find its blind spots", "interrogate"],
    ["Stress test this change before landing it", "interrogate"],
    ["Arena this: competing implementations of the cache", "arena"],
    ["Swarm this check across every package", "swarm"],
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
    interrogate: ["interrogate"],
    arena: ["arena"],
    swarm: ["swarm"],
  };
  for (const [skill, names] of Object.entries(prompts))
    for (const name of names) {
      const text = await readFile(root + "prompts/" + name + ".md", "utf8");
      assert.ok(text.includes("the `" + skill + "` skill"), name);
    }
});

test("the run-proven skills keep the rules that make their results trustworthy", async () => {
  const read = (name) => readFile(skillRoot + "/" + name + "/SKILL.md", "utf8");
  const rules = {
    interrogate: [
      "Report findings. Do not fix them.",
      'Spawn one `adversary` per seat in a\n   single turn, each with `isolation: "worktree"` and its seat\'s `model`.',
      "A finding whose\n   command exits 0 on rerun is dropped, whatever its prose says.",
      "Drop it if it only shows behaviour the intent allows.",
      "A panel of one vendor is the same blind spots repeated: say so.",
    ],
    arena: [
      "Candidates see only the task.",
      "Never give it model names.",
      "Read every candidate end to end yourself and score it per criterion.",
      "A candidate that returns nothing is a dropout: continue and\n   say so.",
    ],
    swarm: [
      "Do not tally the results by reading them yourself.",
      "A second gap\n   stays a gap.",
      "`INCOMPLETE` is not a pass: never round\nit up.",
    ],
  };
  for (const [name, sentences] of Object.entries(rules)) {
    const text = await read(name);
    for (const sentence of sentences) assert.ok(text.includes(sentence), `${name}: ${sentence}`);
  }
  const prompt = await readFile(root + "prompts/interrogate.md", "utf8");
  assert.ok(prompt.includes("Report findings; do not fix them."));
});

test("verification recipes require a safe failure witness or an explicit coverage gap", async () => {
  const text = await readFile(root + "prompts/verify-setup.md", "utf8");
  for (const sentence of [
    "Demonstrate that a meaningful acceptance check rejects a known-bad case in an isolated fixture; never corrupt the live app to manufacture a failure.",
    "If no safe failure witness is practical, mark that check's failure sensitivity unproven and explain why.",
    "Recheck the known-bad witness when its acceptance check changes.",
  ])
    assert.ok(text.includes(sentence), sentence);
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
