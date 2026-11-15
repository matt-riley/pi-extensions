import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import agents from "../index.ts";

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), "agents-ext-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const commands = new Map();
  const notes = [];
  const pi = { registerCommand: (name, definition) => commands.set(name, definition) };
  agents(pi);
  const ctx = { cwd, ui: { notify: (text, level) => notes.push({ text, level }) } };
  const run = (args = "", context = ctx) => commands.get("agents").handler(args, context);
  const read = (rel) => readFileSync(join(cwd, rel), "utf8");
  const exists = (rel) => existsIn(cwd, rel);
  return { root, cwd, commands, notes, run, ctx, read, exists };
}

function existsIn(dir, rel) {
  try {
    lstatSync(join(dir, rel));
    return true;
  } catch {
    return false;
  }
}

const scripts = { build: "tsc", test: "node --test" };

test("registers /agents", (t) => {
  const h = setup(t);
  const command = h.commands.get("agents");
  assert.ok(command);
  assert.match(command.description, /AGENTS\.md/);
});

test("creates an AGENTS.md in the working directory", async (t) => {
  const h = setup(t);
  await h.run();
  assert.match(h.read("AGENTS.md"), /^# AGENTS\.md\n\nGuidance for coding agents/);
  assert.deepEqual(h.notes, [{ text: "agents: created AGENTS.md", level: "info" }]);
});

test("creates it in a chosen directory, with that directory's scripts", async (t) => {
  const h = setup(t);
  mkdirSync(join(h.cwd, "sub dir"));
  writeFileSync(join(h.cwd, "sub dir", "package.json"), JSON.stringify({ scripts }));
  await h.run("  sub dir  ");
  const content = h.read(join("sub dir", "AGENTS.md"));
  assert.match(content, /## Commands\n\n- `npm run build`\n- `npm run test`/);
  assert.equal(h.exists("AGENTS.md"), false, "the session directory is untouched");
});

test("updates an existing file without losing its guidance", async (t) => {
  const h = setup(t);
  writeFileSync(join(h.cwd, "package.json"), JSON.stringify({ scripts }));
  const existing = "# House rules\n\n- Never force-push.\n- Ask before deploying.\n";
  writeFileSync(join(h.cwd, "AGENTS.md"), existing);
  await h.run();
  const content = h.read("AGENTS.md");
  assert.ok(content.startsWith(existing));
  assert.match(content, /## Commands\n\n- `npm run build`/);
  assert.deepEqual(h.notes, [
    { text: "agents: updated AGENTS.md: added Commands, existing content kept", level: "info" },
  ]);
});

test("a file that already documents commands is left byte-for-byte alone", async (t) => {
  const h = setup(t);
  writeFileSync(join(h.cwd, "package.json"), JSON.stringify({ scripts }));
  const existing = "# House rules\n\n## Commands\n\n- `make test`\n";
  writeFileSync(join(h.cwd, "AGENTS.md"), existing);
  await h.run();
  assert.equal(h.read("AGENTS.md"), existing);
  assert.match(h.notes[0].text, /already documents commands/);
  assert.equal(h.notes[0].level, "info");
});

test("without scripts it creates the file, and a second run changes nothing", async (t) => {
  const h = setup(t);
  await h.run();
  const created = h.read("AGENTS.md");
  assert.doesNotMatch(created, /## Commands/);
  h.notes.length = 0;
  await h.run();
  assert.equal(h.read("AGENTS.md"), created);
  assert.match(h.notes[0].text, /no package.json scripts/);
});

test("an invalid package.json does not stop creation", async (t) => {
  const h = setup(t);
  writeFileSync(join(h.cwd, "package.json"), "{ not json");
  await h.run();
  assert.match(h.read("AGENTS.md"), /^# AGENTS\.md/);
  assert.doesNotMatch(h.read("AGENTS.md"), /## Commands/);
});

test("a missing directory is reported and nothing is created", async (t) => {
  const h = setup(t);
  await h.run("missing");
  assert.equal(h.notes[0].level, "error");
  assert.match(h.notes[0].text, /missing: no such directory/);
  assert.equal(h.exists("AGENTS.md"), false);
});

test("a path that is a file is reported as not a directory", async (t) => {
  const h = setup(t);
  writeFileSync(join(h.cwd, "notes.txt"), "x\n");
  await h.run("notes.txt");
  assert.equal(h.notes[0].level, "error");
  assert.match(h.notes[0].text, /notes\.txt is not a directory/);
});

test("an unreadable AGENTS.md is reported and left untouched", async (t) => {
  const h = setup(t);
  mkdirSync(join(h.cwd, "AGENTS.md"));
  await h.run();
  assert.equal(h.notes[0].level, "error");
  assert.match(h.notes[0].text, /AGENTS\.md/);
  assert.equal(lstatSync(join(h.cwd, "AGENTS.md")).isDirectory(), true);
});

test("a case-variant AGENTS.MD is updated instead of duplicated", async (t) => {
  const h = setup(t);
  writeFileSync(join(h.cwd, "package.json"), JSON.stringify({ scripts }));
  writeFileSync(join(h.cwd, "AGENTS.MD"), "# Existing rules\n");
  await h.run();
  const files = readdirSync(h.cwd).filter((name) => name.toLowerCase() === "agents.md");
  assert.deepEqual(files, ["AGENTS.MD"]);
  assert.match(h.read("AGENTS.MD"), /^# Existing rules\n\n## Commands/);
});

test("a symlinked AGENTS.md keeps its link and updates the target", async (t) => {
  const h = setup(t);
  writeFileSync(join(h.cwd, "package.json"), JSON.stringify({ scripts }));
  writeFileSync(join(h.cwd, "real.md"), "# Shared rules\n");
  symlinkSync("real.md", join(h.cwd, "AGENTS.md"));
  await h.run();
  assert.equal(lstatSync(join(h.cwd, "AGENTS.md")).isSymbolicLink(), true);
  assert.match(h.read("real.md"), /^# Shared rules\n\n## Commands/);
  assert.deepEqual(
    readdirSync(h.cwd).filter((name) => name.includes(".tmp-")),
    [],
    "no temp file is left behind",
  );
});

test("AGENTS.override.md is reported instead of shadowed by a new AGENTS.md", async (t) => {
  const h = setup(t);
  writeFileSync(join(h.cwd, "AGENTS.override.md"), "# Overriding rules\n");
  await h.run();
  assert.equal(h.notes[0].level, "warning");
  assert.match(h.notes[0].text, /AGENTS\.override\.md replaces AGENTS\.md/);
  assert.equal(h.exists("AGENTS.md"), false);
});
