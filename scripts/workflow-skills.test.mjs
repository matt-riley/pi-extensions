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
