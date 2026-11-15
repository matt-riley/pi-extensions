import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { checkDocs, formatJson, formatText } from "../stale.mjs";

const run = (cwd) => async (cmd, args) => {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: "utf8",
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return {
      code: error.status ?? 1,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? ""),
    };
  }
};

function repo(t) {
  const root = mkdtempSync(join(tmpdir(), "docs-drift-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync("git", ["-C", root, "-c", "commit.gpgsign=false", ...args], { encoding: "utf8" });
  const put = (rel, text) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  const commit = (message) => {
    git("add", ".");
    git("commit", "-qm", message);
    return git("rev-parse", "HEAD").trim();
  };
  git("init", "-q", "-b", "main");
  git("config", "user.name", "t");
  git("config", "user.email", "t@example.com");
  const check = (prefixes = []) =>
    checkDocs({
      exec: run(root),
      root,
      readFile: async (rel) => readFileSync(join(root, rel), "utf8"),
      prefixes,
    });
  return { root, git, put, commit, check };
}

const byPath = (report) => Object.fromEntries(report.docs.map((doc) => [doc.path, doc]));

function fixture(t) {
  const h = repo(t);
  h.put("src/a.mjs", "export const a = 1;\n");
  h.put("src/b.mjs", "export const b = 1;\n");
  h.put("docs/a.md", "Describes `src/a.mjs`.\n");
  h.put("docs/b.md", "Describes [b](../src/b.mjs).\n");
  h.put("docs/c.md", "Prose that names nothing in the repository.\n");
  h.commit("base");
  h.put("src/a.mjs", "export const a = 2;\n");
  h.commit("change a");
  return h;
}

test("a doc whose mapped code changed after the doc's last commit is stale, and says which file", async (t) => {
  const { check, git } = fixture(t);
  const docs = byPath(await check());
  assert.equal(docs["docs/a.md"].status, "stale");
  assert.deepEqual(
    docs["docs/a.md"].changed.map((item) => item.path),
    ["src/a.mjs"],
  );
  assert.equal(docs["docs/a.md"].changed[0].sha, git("rev-parse", "HEAD").trim());
  assert.match(docs["docs/a.md"].changed[0].date, /^\d{4}-\d\d-\d\dT/);
});

test("a doc whose mapped code is untouched since the doc's last commit is current", async (t) => {
  const { check } = fixture(t);
  const doc = byPath(await check())["docs/b.md"];
  assert.equal(doc.status, "current");
  assert.deepEqual(doc.changed, []);
  assert.deepEqual(
    doc.mapped.map((item) => item.path),
    ["src/b.mjs"],
  );
});

test("a doc that maps to no code is can't tell, never current", async (t) => {
  const { check } = fixture(t);
  const doc = byPath(await check())["docs/c.md"];
  assert.equal(doc.status, "can't tell");
  assert.match(doc.reason, /no code/);
});

test("updating the doc after the code change makes it current again", async (t) => {
  const { check, put, commit } = fixture(t);
  put("docs/a.md", "Describes `src/a.mjs`, now at 2.\n");
  commit("docs: refresh a");
  assert.equal(byPath(await check())["docs/a.md"].status, "current");
});

test("a README describes its own directory; a root README with no mentions is can't tell", async (t) => {
  const { check, put, commit } = repo(t);
  put("pkg/lib.mjs", "export const x = 1;\n");
  put("pkg/README.md", "A small package.\n");
  put("README.md", "The project.\n");
  commit("base");
  put("pkg/lib.mjs", "export const x = 2;\n");
  commit("change lib");
  const docs = byPath(await check());
  assert.equal(docs["pkg/README.md"].status, "stale");
  assert.equal(docs["README.md"].status, "can't tell");
});

test("an identifier the doc names maps the doc to the file that uses it", async (t) => {
  const { check, put, commit } = repo(t);
  put("src/parse.mjs", "export function parseConfig() {}\n");
  put("docs/guide.md", "Call `parseConfig()` first.\n");
  commit("base");
  put("src/parse.mjs", "export function parseConfig(input) {}\n");
  commit("change parse");
  const doc = byPath(await check())["docs/guide.md"];
  assert.equal(doc.status, "stale");
  assert.equal(doc.mapped[0].via, "identifier parseConfig");
});

test("AGENTS.md and CLAUDE.md are judged like any other doc", async (t) => {
  const { check, put, commit } = repo(t);
  put("src/x.mjs", "export const x = 1;\n");
  put("AGENTS.md", "Rules for `src/x.mjs`.\n");
  put("CLAUDE.md", "Rules for `src/x.mjs`.\n");
  commit("base");
  put("src/x.mjs", "export const x = 2;\n");
  commit("change x");
  put("CLAUDE.md", "Rules for `src/x.mjs`, updated.\n");
  commit("docs: claude");
  const docs = byPath(await check());
  assert.equal(docs["AGENTS.md"].status, "stale");
  assert.equal(docs["CLAUDE.md"].status, "current");
});

test("a shallow clone is can't tell for every doc", async (t) => {
  const source = fixture(t);
  const clone = mkdtempSync(join(tmpdir(), "docs-drift-shallow-"));
  t.after(() => rmSync(clone, { recursive: true, force: true }));
  execFileSync("git", ["clone", "-q", "--depth", "1", `file://${source.root}`, clone]);
  const report = await checkDocs({
    exec: run(clone),
    root: clone,
    readFile: async (rel) => readFileSync(join(clone, rel), "utf8"),
  });
  assert.equal(report.docs.length, 3);
  for (const doc of report.docs) {
    assert.equal(doc.status, "can't tell");
    assert.match(doc.reason, /shallow/);
  }
});

test("a repository with no commits is can't tell", async (t) => {
  const { check, put, git } = repo(t);
  put("docs/a.md", "Describes `src/a.mjs`.\n");
  put("src/a.mjs", "export const a = 1;\n");
  git("add", ".");
  const docs = (await check()).docs;
  assert.equal(docs.length, 1);
  assert.equal(docs[0].status, "can't tell");
  assert.match(docs[0].reason, /no commits/);
});

test("outside a git repository the answer is can't tell", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "docs-drift-plain-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const report = await checkDocs({ exec: run(dir), root: dir, readFile: async () => null });
  assert.equal(report.docs.length, 1);
  assert.equal(report.docs[0].status, "can't tell");
  assert.match(report.docs[0].reason, /not a git repository/);
});

test("path arguments limit which docs are judged", async (t) => {
  const { check } = fixture(t);
  assert.deepEqual(
    (await check(["docs/a.md"])).docs.map((doc) => doc.path),
    ["docs/a.md"],
  );
  assert.deepEqual(
    (await check(["docs"])).docs.map((doc) => doc.path),
    ["docs/a.md", "docs/b.md", "docs/c.md"],
  );
});

test("text output is one line per doc with the status first, then a summary", async (t) => {
  const { check } = fixture(t);
  const lines = formatText(await check()).split("\n");
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^stale\tdocs\/a\.md\t.*src\/a\.mjs/);
  assert.match(lines[1], /^current\tdocs\/b\.md\t/);
  assert.match(lines[2], /^can't tell\tdocs\/c\.md\t/);
  assert.equal(lines[3], "docs-drift: 1 stale, 1 current, 1 can't tell (3 docs)");
});

test("json output carries the same statuses and the mapped files", async (t) => {
  const { check } = fixture(t);
  const parsed = JSON.parse(formatJson(await check()));
  assert.deepEqual(
    parsed.docs.map((doc) => doc.status),
    ["stale", "current", "can't tell"],
  );
  assert.deepEqual(parsed.summary, { stale: 1, current: 1, "can't tell": 1 });
});
