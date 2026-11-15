import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { LOCAL_READ } from "../../../shared/tool-annotations.mjs";
import affected from "../index.ts";

function setup(t) {
  const cwd = mkdtempSync(join(tmpdir(), "affected-ext-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", ["-C", cwd, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  const put = (rel, text) => {
    mkdirSync(dirname(join(cwd, rel)), { recursive: true });
    writeFileSync(join(cwd, rel), text);
  };
  git("init", "-q");
  git("config", "user.name", "t");
  git("config", "user.email", "t@example.com");
  put("package.json", JSON.stringify({ scripts: { test: "node --test" } }));
  put("src/a.mjs", "export const a = 1;\n");
  put("src/a.test.mjs", 'import "./a.mjs";\n');
  put("src/other.mjs", "export const o = 1;\n");
  git("add", ".");
  git("commit", "-qm", "base");

  const commands = new Map();
  const tools = new Map();
  const notes = [];
  const pi = {
    registerCommand: (name, definition) => commands.set(name, definition),
    registerTool: (definition) => tools.set(definition.name, definition),
    exec: async (cmd, args) => {
      try {
        const stdout = execFileSync(cmd, args, { encoding: "utf8", cwd });
        return { code: 0, stdout, stderr: "" };
      } catch (error) {
        return { code: error.status ?? 1, stdout: "", stderr: String(error.stderr ?? "") };
      }
    },
  };
  affected(pi);
  const ctx = { cwd, ui: { notify: (text, level) => notes.push({ text, level }) } };
  return { git, put, commands, tools, notes, ctx };
}

test("registers /affected and a deferred read-only affected_tests tool", (t) => {
  const { commands, tools } = setup(t);
  assert.ok(commands.has("affected"));
  const tool = tools.get("affected_tests");
  assert.equal(tool.exposure, "deferred");
  assert.deepEqual(tool.annotations, LOCAL_READ);
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ["base", "files"]);
});

test("/affected names the test that reaches an edited file and runs nothing", async (t) => {
  const h = setup(t);
  h.put("src/a.mjs", "export const a = 2;\n");
  await h.commands.get("affected").handler("", h.ctx);
  assert.equal(h.notes[0].level, "info");
  assert.match(h.notes[0].text, /src\/a\.test\.mjs/);
  assert.match(h.notes[0].text, /Nothing was run/);
  assert.doesNotMatch(h.notes[0].text, /other\.mjs/);
});

test("an untracked new test and a clean tree are both handled", async (t) => {
  const h = setup(t);
  await h.commands.get("affected").handler("", h.ctx);
  assert.match(h.notes[0].text, /no changed files/);
  h.put("src/new.test.mjs", 'import "./a.mjs";\n');
  const result = await h.tools.get("affected_tests").execute("id", {}, undefined, undefined, h.ctx);
  assert.deepEqual(result.structuredContent.tests, ["src/new.test.mjs"]);
});

test("a base ref covers what a branch committed since it forked", async (t) => {
  const h = setup(t);
  h.git("tag", "fork-point");
  h.put("src/a.mjs", "export const a = 3;\n");
  h.git("commit", "-qam", "change a");
  const tool = h.tools.get("affected_tests");
  assert.deepEqual(
    (await tool.execute("id", {}, undefined, undefined, h.ctx)).content[0].text,
    "Affected tests: no changed files. Nothing was run.",
  );
  const result = await tool.execute("id", { base: "fork-point" }, undefined, undefined, h.ctx);
  assert.deepEqual(result.structuredContent.tests, ["src/a.test.mjs"]);
});

test("explicit files skip git, and a bad base is reported as an error result", async (t) => {
  const h = setup(t);
  const tool = h.tools.get("affected_tests");
  const explicit = await tool.execute("id", { files: ["src/a.mjs"] }, undefined, undefined, h.ctx);
  assert.deepEqual(explicit.structuredContent.tests, ["src/a.test.mjs"]);
  const bad = await tool.execute("id", { base: "--output=x" }, undefined, undefined, h.ctx);
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /not a usable ref/);
});

test("the fallback is a warning in the command", async (t) => {
  const h = setup(t);
  h.put("src/a.mjs", "await import(name);\n");
  await h.commands.get("affected").handler("", h.ctx);
  assert.equal(h.notes[0].level, "warning");
  assert.match(h.notes[0].text, /Run npm test instead/);
});
