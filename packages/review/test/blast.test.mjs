import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { classifyHits, definitionNames, report, touchedSymbols } from "../blast.mjs";

const DIFF = `diff --git a/lib/a.mjs b/lib/a.mjs
--- a/lib/a.mjs
+++ b/lib/a.mjs
@@ -3,2 +3,2 @@ export function parseThing(input) {
-  return input.trim();
+  return input.trim().toLowerCase();
@@ -20,0 +21,2 @@
+export const fresh = 1;
+export const helperValue = 2;
`;

test("definitionNames reads declarations and drops short names", () => {
  assert.deepEqual(definitionNames("export async function loadAll() {"), ["loadAll"]);
  assert.deepEqual(definitionNames("export class Widget {}"), ["Widget"]);
  assert.deepEqual(definitionNames("  export const localValue = 1;"), []);
  assert.deepEqual(definitionNames("const notExported = 1;"), []);
  assert.deepEqual(definitionNames("return input.trim();"), []);
});

test("touchedSymbols finds a function whose body alone changed via the hunk header", () => {
  const files = touchedSymbols(DIFF);
  assert.deepEqual([...files.get("lib/a.mjs")].sort(), ["fresh", "helperValue", "parseThing"]);
});

test("classifyHits separates diff files, outside callers and tests", () => {
  const hits = ["lib/a.mjs", "lib/b.mjs", "test/b.test.mjs"];
  assert.deepEqual(classifyHits(hits, new Set(["lib/a.mjs"])), {
    outside: ["lib/b.mjs"],
    tests: ["test/b.test.mjs"],
  });
});

test("report lists outside callers and flags a symbol no test mentions", async () => {
  const grep = (name) =>
    name === "parseThing" ? ["lib/a.mjs", "lib/b.mjs", "lib/c.test.mjs"] : ["lib/a.mjs"];
  const out = await report(DIFF, grep);
  assert.match(
    out,
    /parseThing \(lib\/a\.mjs\): 1 caller file\(s\) outside the diff\n {2}lib\/b\.mjs/,
  );
  assert.match(out, /fresh .*no test mentions it/);
  assert.doesNotMatch(out, /parseThing .*no test mentions/);
});

test("report says so when nothing is touched", async () => {
  assert.equal(await report("", () => []), "No definitions touched.");
});

test("touchedSymbols reads a real diff even when git is set to mnemonic prefixes", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "blast-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  git("init", "-q");
  git("config", "diff.mnemonicPrefix", "true");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  writeFileSync(path.join(dir, "a.mjs"), "export function oldName() {}\n");
  git("add", ".");
  git("commit", "-qm", "init");
  writeFileSync(path.join(dir, "a.mjs"), "export function newName() {}\n");
  const diff = git("diff", "-U0", "--src-prefix=a/", "--dst-prefix=b/", "HEAD");
  assert.deepEqual([...touchedSymbols(diff).get("a.mjs")].sort(), ["newName", "oldName"]);
});
