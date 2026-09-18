import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverSkills,
  formatMatches,
  parseFrontmatter,
  rankSkills,
  resolveRoots,
} from "../library.mjs";

async function tmpTree() {
  const dir = await mkdtemp(join(tmpdir(), "pi-skill-select-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

async function writeSkill(root, name, { frontmatter, body = "# Skill\n" } = {}) {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  const yaml = frontmatter ?? `name: ${name}\ndescription: ${name} skill\n`;
  await writeFile(join(dir, "SKILL.md"), `---\n${yaml}---\n\n${body}`);
}

test("parseFrontmatter handles plain, folded, literal and quoted values", () => {
  assert.deepEqual(
    parseFrontmatter("---\nname: pdf-tools\ndescription: Extract text from PDFs.\n---\nbody"),
    { name: "pdf-tools", description: "Extract text from PDFs." },
  );
  assert.deepEqual(
    parseFrontmatter("---\nname: folded\ndescription: >\n  Line one\n  line two.\n---\nbody"),
    { name: "folded", description: "Line one line two." },
  );
  assert.deepEqual(
    parseFrontmatter("---\nname: literal\ndescription: |\n  Keep\n  breaks.\n---\nbody"),
    { name: "literal", description: "Keep\nbreaks." },
  );
  assert.deepEqual(
    parseFrontmatter("---\nname: \"quoted\"\ndescription: 'single quoted'\n---\nbody"),
    { name: "quoted", description: "single quoted" },
  );
  assert.deepEqual(parseFrontmatter("no frontmatter here"), { name: "", description: "" });
  assert.deepEqual(parseFrontmatter("\uFEFF---\r\nname: crlf\r\ndescription: ok\r\n---\r\n"), {
    name: "crlf",
    description: "ok",
  });
});

test("resolveRoots puts the explicit library first and dedupes", () => {
  const roots = resolveRoots({
    cwd: "/work/project",
    home: "/home/u",
    env: { PI_SKILL_LIBRARY: "/lib/one:/lib/two,/lib/one" },
  });
  assert.deepEqual(roots, [
    "/lib/one",
    "/lib/two",
    "/home/u/.pi/agent/skill-library",
    "/home/u/.pi/agent/skills",
    "/home/u/.agents/skills",
    "/home/u/.claude/skills",
    "/home/u/.codex/skills",
    "/work/project/.pi/skills",
    "/work/project/.agents/skills",
  ]);
});

test("discoverSkills finds nested skills, falls back to the directory name and skips node_modules", async () => {
  const { dir, cleanup } = await tmpTree();
  try {
    await writeSkill(dir, "alpha");
    await mkdir(join(dir, ".system"), { recursive: true });
    await writeSkill(join(dir, ".system"), "hidden-but-real");
    await mkdir(join(dir, "node_modules"), { recursive: true });
    await writeSkill(join(dir, "node_modules"), "vendored");
    await writeSkill(dir, "no-frontmatter", { frontmatter: "" });

    const skills = await discoverSkills({ roots: [dir, join(dir, "missing")] });
    const byName = Object.fromEntries(skills.map((s) => [s.name, s]));

    assert.deepEqual(Object.keys(byName).sort(), ["alpha", "hidden-but-real", "no-frontmatter"]);
    assert.equal(byName.alpha.description, "alpha skill");
    assert.equal(
      byName["hidden-but-real"].path,
      join(dir, ".system", "hidden-but-real", "SKILL.md"),
    );
    assert.equal(byName["no-frontmatter"].description, "");
    assert.equal(byName["no-frontmatter"].path, join(dir, "no-frontmatter", "SKILL.md"));
  } finally {
    await cleanup();
  }
});

test("discoverSkills dedupes by name, keeping the earlier root", async () => {
  const { dir, cleanup } = await tmpTree();
  try {
    const first = join(dir, "library");
    const second = join(dir, "other");
    await writeSkill(first, "shared", { frontmatter: "name: shared\ndescription: from library\n" });
    await writeSkill(second, "shared", { frontmatter: "name: shared\ndescription: from other\n" });

    const skills = await discoverSkills({ roots: [first, second] });
    assert.equal(skills.length, 1);
    assert.equal(skills[0].description, "from library");
  } finally {
    await cleanup();
  }
});

function skill(name, description) {
  return { name, description, path: `/lib/${name}/SKILL.md`, root: "/lib" };
}

test("rankSkills scores names above descriptions and phrases above tokens", () => {
  const skills = [
    skill("sandbox-next", "Run untrusted code in a sandbox."),
    skill("deploy-helper", "Deploys the sandbox service."),
    skill("unrelated", "Nothing to do with the query."),
  ];
  const ranked = rankSkills(skills, "sandbox");
  assert.deepEqual(
    ranked.map((entry) => entry.name),
    ["sandbox-next", "deploy-helper"],
  );
  assert.ok(ranked[0].score > ranked[1].score);

  const phrase = rankSkills(skills, "sandbox next");
  assert.equal(phrase[0].name, "sandbox-next");
});

test("rankSkills matches word variants like migration and migrations", () => {
  // Faithful to the real entries: the AWS blurb contains "migration", so exact
  // token scoring ties them and alphabetical order wrongly wins.
  const skills = [
    skill(
      "aws-sdk-v2-to-v3-migration",
      "The codebase needs a safe modular v3 migration with minimal downtime.",
    ),
    skill(
      "sandbox-migrate-to-next",
      "Use when porting a Cloudflare Sandbox app, or when the user asks to migrate to Sandbox 1.0.",
    ),
  ];
  assert.deepEqual(
    rankSkills(skills, "sandbox migration").map((entry) => entry.name),
    ["sandbox-migrate-to-next", "aws-sdk-v2-to-v3-migration"],
  );
  assert.ok(
    rankSkills(skills, "sandbox migration")[0].score >
      rankSkills(skills, "sandbox migration")[1].score,
  );
});

test("rankSkills with an empty query browses the catalog alphabetically", () => {
  const ranked = rankSkills([skill("zeta", "z"), skill("alpha", "a")], "", { limit: 1 });
  assert.deepEqual(
    ranked.map((entry) => entry.name),
    ["alpha"],
  );
});

test("discoverSkills skips archived directories at any depth", async () => {
  const { dir, cleanup } = await tmpTree();
  try {
    await writeSkill(dir, "active-skill");
    await writeSkill(join(dir, "archived"), "retired-skill");
    await writeSkill(join(dir, "active-skill", "archived"), "nested-retired-skill");
    await writeSkill(join(dir, "Archived"), "case-insensitive");

    const skills = await discoverSkills({ roots: [dir] });
    assert.deepEqual(
      skills.map((s) => s.name),
      ["active-skill"],
    );
  } finally {
    await cleanup();
  }
});

test("discoverSkills follows symlinked directories once, without looping", async () => {
  const { dir, cleanup } = await tmpTree();
  try {
    const real = join(dir, "real");
    await writeSkill(real, "linked-skill");
    const library = join(dir, "library");
    await mkdir(library, { recursive: true });
    await symlink(real, join(library, "alias"));
    // Cycle: the real tree links back to the library root that links to it.
    await symlink(library, join(real, "loop"));

    const skills = await discoverSkills({ roots: [library] });
    assert.deepEqual(
      skills.map((s) => s.name),
      ["linked-skill"],
    );
    assert.equal(skills[0].path, join(library, "alias", "linked-skill", "SKILL.md"));
  } finally {
    await cleanup();
  }
});

test("formatMatches renders ranked matches with paths and a read hint", () => {
  const text = formatMatches([{ ...skill("pdf-tools", "Extract text from PDFs."), score: 12 }], {
    query: "pdf",
    total: 3,
  });
  assert.match(text, /1\. pdf-tools/);
  assert.match(text, /Extract text from PDFs\./);
  assert.match(text, /\/lib\/pdf-tools\/SKILL\.md/);
  assert.match(text, /read/i);
});

test("formatMatches reports an empty result honestly", () => {
  const text = formatMatches([], { query: "nothing", total: 3 });
  assert.match(text, /no skill/i);
  assert.match(text, /nothing/);
});
