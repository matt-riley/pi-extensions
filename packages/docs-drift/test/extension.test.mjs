import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import docsDrift from "../index.ts";

function setup(t) {
  const cwd = mkdtempSync(join(tmpdir(), "docs-drift-ext-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", ["-C", cwd, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  const put = (rel, text) => {
    mkdirSync(dirname(join(cwd, rel)), { recursive: true });
    writeFileSync(join(cwd, rel), text);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "t");
  git("config", "user.email", "t@example.com");
  put("src/a.mjs", "export const a = 1;\n");
  put("docs/a.md", "Describes `src/a.mjs`.\n");
  put("docs/n.md", "Names nothing.\n");
  git("add", ".");
  git("commit", "-qm", "base");
  put("src/a.mjs", "export const a = 2;\n");
  git("commit", "-qam", "change a");

  const commands = new Map();
  const notes = [];
  const pi = {
    registerCommand: (name, definition) => commands.set(name, definition),
    exec: async (cmd, args) => {
      try {
        const stdout = execFileSync(cmd, args, {
          encoding: "utf8",
          cwd,
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { code: 0, stdout, stderr: "" };
      } catch (error) {
        return { code: error.status ?? 1, stdout: "", stderr: String(error.stderr ?? "") };
      }
    },
  };
  docsDrift(pi);
  const ctx = { cwd, ui: { notify: (text, level) => notes.push({ text, level }) } };
  const call = (args) => commands.get("docs-drift").handler(args, ctx);
  return { commands, notes, call };
}

test("registers /docs-drift", (t) => {
  assert.ok(setup(t).commands.has("docs-drift"));
});

test("/docs-drift prints one status-first line per doc and warns when a doc is stale", async (t) => {
  const { call, notes } = setup(t);
  await call("");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].level, "warning");
  const lines = notes[0].text.split("\n");
  assert.match(lines[0], /^stale\tdocs\/a\.md\t/);
  assert.match(lines[1], /^can't tell\tdocs\/n\.md\t/);
});

test("/docs-drift --json prints parseable JSON", async (t) => {
  const { call, notes } = setup(t);
  await call("--json");
  assert.equal(JSON.parse(notes[0].text).docs[0].status, "stale");
});

test("/docs-drift with a path judges only the docs under it", async (t) => {
  const { call, notes } = setup(t);
  await call("docs/n.md");
  assert.match(notes[0].text, /^can't tell\tdocs\/n\.md\t/);
  assert.doesNotMatch(notes[0].text, /docs\/a\.md/);
  assert.equal(notes[0].level, "info");
});

test("/docs-drift rejects unknown flags with the usage line", async (t) => {
  const { call, notes } = setup(t);
  await call("--fix");
  assert.match(notes[0].text, /^Usage: \/docs-drift/);
});
