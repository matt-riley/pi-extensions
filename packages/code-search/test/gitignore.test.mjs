import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compilePattern,
  collectRules,
  matchPath,
  parseGitignore,
} from "../gitignore.mjs";

const rules = (text, base = "") => parseGitignore(text, { base });

test("basename patterns match at any depth", () => {
  const r = rules("node_modules");
  assert.equal(matchPath("node_modules", true, r), true);
  assert.equal(matchPath("a/node_modules", true, r), true);
  assert.equal(matchPath("a/b/node_modules", true, r), true);
  assert.equal(matchPath("src/index.ts", false, r), false);
});

test("anchored patterns only match at the base", () => {
  const r = rules("/dist");
  assert.equal(matchPath("dist", true, r), true);
  assert.equal(matchPath("a/dist", true, r), false);
});

test("trailing slash is directory-only", () => {
  const r = rules("build/");
  assert.equal(matchPath("build", true, r), true);
  assert.equal(matchPath("build", false, r), false);
  assert.equal(matchPath("build/x.ts", false, r), false); // parent excluded at walk level
});

test("negation re-includes within a file", () => {
  const r = rules("*.log\n!important.log");
  assert.equal(matchPath("a.log", false, r), true);
  assert.equal(matchPath("important.log", false, r), false);
});

test("later rules override earlier ones", () => {
  const r = rules("*.ts\n!keep.ts\n*.ts\n");
  assert.equal(matchPath("keep.ts", false, r), true); // last `*.ts` wins
});

test("question mark and character classes", () => {
  const r = rules("file?.txt\n[a-c].log");
  assert.equal(matchPath("file1.txt", false, r), true);
  assert.equal(matchPath("fileX.txt", false, r), true);
  assert.equal(matchPath("fileX.log", false, r), false);
  assert.equal(matchPath("b.log", false, r), true);
  assert.equal(matchPath("d.log", false, r), false);
});

test("double-star matches across directories", () => {
  const r = rules("**/tmp/**");
  assert.equal(matchPath("tmp/x", false, r), true);
  assert.equal(matchPath("a/b/tmp/x/y", false, r), true);
  assert.equal(matchPath("a/tmpb/x", false, r), false);
});

test("leading **/ and trailing /**", () => {
  const lead = rules("**/foo");
  assert.equal(matchPath("foo", false, lead), true);
  assert.equal(matchPath("a/b/foo", false, lead), true);
  const trail = rules("foo/**");
  assert.equal(matchPath("foo/x", false, trail), true);
  assert.equal(matchPath("foo/x/y", false, trail), true);
  assert.equal(matchPath("foo", true, trail), false);
});

test("nested .gitignore bases are scoped", () => {
  const r = [...rules("*.tmp"), ...rules("secret.txt", "sub")];
  assert.equal(matchPath("sub/secret.txt", false, r), true);
  assert.equal(matchPath("secret.txt", false, r), false);
  assert.equal(matchPath("other/sub2/secret.txt", false, r), false);
  assert.equal(matchPath("sub/x.tmp", false, r), true);
});

test("comment and blank lines are ignored", () => {
  const r = rules("# comment\n\nfoo\n");
  assert.equal(matchPath("foo", false, r), true);
  assert.equal(matchPath("comment", false, r), false);
});

test("escaped literal characters", () => {
  const r = rules("\\#hash");
  assert.equal(matchPath("#hash", false, r), true);
  assert.equal(matchPath("other", false, r), false);
});

test("compilePattern rejects empty/negation-only patterns", () => {
  assert.equal(compilePattern(""), null);
  assert.equal(compilePattern("!"), null);
  assert.equal(compilePattern("/"), null);
});

test("collectRules gathers global + info/exclude + root gitignore", () => {
  const readFile = (p) => {
    if (p.endsWith("/.gitignore")) return "dist/\n";
    if (p.endsWith("/.git/info/exclude")) return "*.swp\n";
    if (p.includes("git/ignore")) return "*.log\n";
    return null;
  };
  const r = collectRules({ rootDir: "/repo", readFile, homeDir: "/home/u" });
  assert.equal(matchPath("a.swp", false, r), true);
  assert.equal(matchPath("b.log", false, r), true);
  assert.equal(matchPath("dist", true, r), true);
  assert.equal(matchPath("src/x.ts", false, r), false);
});
