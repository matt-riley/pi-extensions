import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { LOCAL_READ } from "../../../shared/tool-annotations.mjs";
import architecture from "../index.ts";

function setup(t, tree) {
  const cwd = mkdtempSync(join(tmpdir(), "architecture-ext-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  for (const [rel, text] of Object.entries(tree)) {
    mkdirSync(dirname(join(cwd, rel)), { recursive: true });
    writeFileSync(join(cwd, rel), text);
  }
  const commands = new Map();
  const tools = new Map();
  const notes = [];
  const pi = {
    registerCommand: (name, definition) => commands.set(name, definition),
    registerTool: (definition) => tools.set(definition.name, definition),
    exec: async () => ({ code: 1, stdout: "", stderr: "not a git repository" }),
  };
  architecture(pi);
  const ctx = { cwd, ui: { notify: (text, level) => notes.push({ text, level }) } };
  return { commands, tools, notes, ctx, cwd };
}

const RULES = JSON.stringify({
  rules: [{ name: "shared-is-a-leaf", from: "shared/**", forbid: ["packages/**"] }],
});

test("registers /architecture and a deferred read-only architecture_check tool", (t) => {
  const { commands, tools } = setup(t, {});
  assert.ok(commands.has("architecture"));
  const tool = tools.get("architecture_check");
  assert.equal(tool.exposure, "deferred");
  assert.deepEqual(tool.annotations, LOCAL_READ);
  assert.deepEqual(tool.parameters.properties, {});
});

test("/architecture reports a violation as a warning with the rule and the line", async (t) => {
  const h = setup(t, {
    ".pi/architecture.json": RULES,
    "shared/leak.mjs": 'import "../packages/a/x";',
    "packages/a/x.ts": "",
  });
  await h.commands.get("architecture").handler("", h.ctx);
  assert.equal(h.notes.length, 1);
  assert.equal(h.notes[0].level, "warning");
  assert.match(h.notes[0].text, /shared-is-a-leaf: shared\/leak\.mjs:1 -> packages\/a\/x\.ts/);
});

test("the tool returns the text and the structured report, and writes nothing", async (t) => {
  const h = setup(t, {
    ".pi/architecture.json": RULES,
    "shared/ok.mjs": "export const ok = 1;",
  });
  const result = await h.tools
    .get("architecture_check")
    .execute("id", {}, undefined, undefined, h.ctx);
  assert.match(result.content[0].text, /no violations, no cycles, coverage complete/);
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.coverage.complete, true);
  assert.equal(h.notes.length, 0);
});

test("a repository with no rules file still gets the cycle check", async (t) => {
  const h = setup(t, { "src/a.ts": 'import "./b";', "src/b.ts": 'import "./a";' });
  await h.commands.get("architecture").handler("", h.ctx);
  assert.match(h.notes[0].text, /no rules file/i);
  assert.match(h.notes[0].text, /src\/a\.ts -> src\/b\.ts -> src\/a\.ts/);
});
