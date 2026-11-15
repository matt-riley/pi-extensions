import { test } from "node:test";
import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
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
  const messages = [];
  const pi = {
    registerCommand: (name, definition) => commands.set(name, definition),
    sendUserMessage: (text, options) => messages.push({ text, options }),
  };
  agents(pi);
  const ctx = { cwd, ui: { notify: (text, level) => notes.push({ text, level }) } };
  const run = (args = "", context = ctx) => commands.get("agents").handler(args, context);
  const read = (rel) => readFileSync(join(cwd, rel), "utf8");
  return { root, cwd, commands, notes, messages, run, ctx, read };
}

test("registers /agents and delegates creation without writing a placeholder", async (t) => {
  const h = setup(t);
  assert.match(h.commands.get("agents").description, /AGENTS\.md/);
  await h.run();
  assert.equal(h.messages.length, 1);
  assert.deepEqual(h.messages[0].options, { deliverAs: "followUp" });
  assert.ok(h.messages[0].text.includes(JSON.stringify(join(h.cwd, "AGENTS.md"))));
  assert.deepEqual(readdirSync(h.cwd), []);
  assert.deepEqual(h.notes, [], "dispatch is not reported as a completed file edit");
});

test("targets a chosen directory with spaces, relative or absolute", async (t) => {
  const h = setup(t);
  const dir = join(h.cwd, "sub dir");
  mkdirSync(dir);
  for (const arg of ["  sub dir  ", dir]) {
    await h.run(arg);
    assert.ok(h.messages.at(-1).text.includes(JSON.stringify(dir)));
    assert.ok(h.messages.at(-1).text.includes(JSON.stringify(join(dir, "AGENTS.md"))));
  }
  assert.equal(h.messages.length, 2);
  assert.deepEqual(readdirSync(dir), []);
});

test("an existing Commands section still gets an improvement request preserving guidance", async (t) => {
  const h = setup(t);
  const existing = "# Rules\n\nNever force-push.\n\n## Commands\n\nmake test\n";
  writeFileSync(join(h.cwd, "AGENTS.md"), existing);
  await h.run();
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0].text, /Read the complete existing file before editing/);
  assert.match(h.messages[0].text, /Preserve useful existing guidance/);
  assert.equal(h.read("AGENTS.md"), existing, "dispatch does not eagerly overwrite user guidance");
});

test("invalid or absent package.json does not prevent repository inspection", async (t) => {
  const h = setup(t);
  writeFileSync(join(h.cwd, "package.json"), "{ not json");
  await h.run();
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0].text, /Support non-JavaScript projects too/);
});

test("a missing directory is reported without sending work", async (t) => {
  const h = setup(t);
  await h.run("missing");
  assert.equal(h.messages.length, 0);
  assert.equal(h.notes[0].level, "error");
  assert.match(h.notes[0].text, /missing: no such directory/);
});

test("a path that is a file is reported as not a directory", async (t) => {
  const h = setup(t);
  writeFileSync(join(h.cwd, "notes.txt"), "x\n");
  await h.run("notes.txt");
  assert.equal(h.messages.length, 0);
  assert.equal(h.notes[0].level, "error");
  assert.match(h.notes[0].text, /notes\.txt is not a directory/);
});

test("an unreadable AGENTS.md is reported and left untouched", async (t) => {
  const h = setup(t);
  mkdirSync(join(h.cwd, "AGENTS.md"));
  await h.run();
  assert.equal(h.messages.length, 0);
  assert.equal(h.notes[0].level, "error");
  assert.equal(lstatSync(join(h.cwd, "AGENTS.md")).isDirectory(), true);
});

test("a case-variant AGENTS.MD is targeted instead of duplicated", async (t) => {
  const h = setup(t);
  writeFileSync(join(h.cwd, "AGENTS.MD"), "# Existing rules\n");
  await h.run();
  assert.equal(h.messages.length, 1);
  assert.ok(h.messages[0].text.includes(JSON.stringify(join(h.cwd, "AGENTS.MD"))));
  assert.deepEqual(readdirSync(h.cwd), ["AGENTS.MD"]);
  assert.equal(h.read("AGENTS.MD"), "# Existing rules\n");
});

test("a symlinked AGENTS.md targets its resolved file without replacing the link", async (t) => {
  const h = setup(t);
  writeFileSync(join(h.root, "real.md"), "# Shared rules\n");
  symlinkSync("../real.md", join(h.cwd, "AGENTS.md"));
  await h.run();
  assert.equal(h.messages.length, 1);
  assert.ok(
    h.messages[0].text.includes(
      `Only edit ${JSON.stringify(realpathSync(join(h.root, "real.md")))}`,
    ),
  );
  assert.equal(lstatSync(join(h.cwd, "AGENTS.md")).isSymbolicLink(), true);
  assert.equal(h.read("AGENTS.md"), "# Shared rules\n");
});

test("a broken instruction symlink is not replaced or queued", async (t) => {
  const h = setup(t);
  symlinkSync("missing.md", join(h.cwd, "AGENTS.md"));
  await h.run();
  assert.equal(h.messages.length, 0);
  assert.equal(h.notes[0].level, "error");
  assert.equal(lstatSync(join(h.cwd, "AGENTS.md")).isSymbolicLink(), true);
});

test("AGENTS.override.md is reported whether or not AGENTS.md exists", async (t) => {
  const h = setup(t);
  writeFileSync(join(h.cwd, "AGENTS.override.md"), "# Overriding rules\n");
  for (const existing of [false, true]) {
    if (existing) writeFileSync(join(h.cwd, "AGENTS.md"), "# Shadowed\n");
    await h.run();
    assert.equal(h.messages.length, 0);
    assert.equal(h.notes.at(-1).level, "warning");
    assert.match(h.notes.at(-1).text, /AGENTS\.override\.md replaces AGENTS\.md/);
  }
  assert.equal(h.read("AGENTS.override.md"), "# Overriding rules\n");
});

test("dispatch failure is reported without changing instructions", async (t) => {
  const h = setup(t);
  writeFileSync(join(h.cwd, "AGENTS.md"), "# Rules\n");
  agents({
    registerCommand: (name, definition) => h.commands.set(name, definition),
    sendUserMessage: () => {
      throw new Error("session unavailable");
    },
  });
  await h.run();
  assert.equal(h.read("AGENTS.md"), "# Rules\n");
  assert.match(h.notes[0].text, /session unavailable/);
  assert.equal(h.notes[0].level, "error");
});
