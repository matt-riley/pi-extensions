import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ALWAYS_EXCLUDED_PREFIXES,
  findRepoRoot,
  isExcludedPath,
  listRepoFiles,
  normalizeRel,
  walkRoot,
} from "../inventory.mjs";

async function fixture(files) {
  const dir = await mkdtemp(join(tmpdir(), "pi-cs-inv-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    await mkdir(p.slice(0, p.lastIndexOf("/")), { recursive: true });
    await writeFile(p, content ?? "");
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("normalizeRel strips ./ and collapses ..", () => {
  assert.equal(normalizeRel("./src/a.ts"), "src/a.ts");
  assert.equal(normalizeRel("src\\a.ts"), "src/a.ts");
  assert.equal(normalizeRel("a/../b.ts"), "b.ts");
  assert.equal(normalizeRel("a//b///c.ts"), "a/b/c.ts");
});

test("isExcludedPath covers node_modules, .git, .pi/cache", () => {
  assert.equal(isExcludedPath("node_modules/x.js"), true);
  assert.equal(isExcludedPath(".git/config"), true);
  assert.equal(isExcludedPath(".pi/cache/pi-code-search.json"), true);
  assert.equal(isExcludedPath(".pi/settings.json"), false);
  assert.equal(isExcludedPath("src/x.ts"), false);
  assert.deepEqual(ALWAYS_EXCLUDED_PREFIXES, ["node_modules", ".git", ".pi/cache"]);
});

test("findRepoRoot uses git toplevel when available", async () => {
  const exec = async (_cmd, args) => {
    if (args.includes("rev-parse")) {
      return { code: 0, stdout: "/git/root\n", stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "" };
  };
  const { root, viaGit } = await findRepoRoot("/any/cwd", exec);
  assert.equal(root, "/git/root");
  assert.equal(viaGit, true);
});

test("findRepoRoot falls back to cwd when git fails", async () => {
  const exec = async () => ({ code: 1, stdout: "", stderr: "" });
  const { root, viaGit } = await findRepoRoot("/plain/dir", exec);
  assert.equal(root, "/plain/dir");
  assert.equal(viaGit, false);
});

test("listRepoFiles uses git ls-files and filters excluded paths", async () => {
  const exec = async (_cmd, args) => {
    if (args.includes("ls-files")) {
      const out = "src/a.ts\u0000node_modules/dep.js\u0000.pi/cache/x.json\u0000README.md\u0000";
      return { code: 0, stdout: out, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "" };
  };
  const { files, viaGit } = await listRepoFiles({ root: "/r", exec });
  assert.equal(viaGit, true);
  assert.deepEqual(files, ["src/a.ts", "README.md"]);
});

test("listRepoFiles falls back to the walker when git is unavailable", async () => {
  const { dir, cleanup } = await fixture({
    "a.ts": "// x",
    "sub/b.ts": "// y",
    "node_modules/z.js": "// z",
    ".gitignore": "*.log\n",
    "ignored.log": "x",
  });
  try {
    const { files, viaGit } = await listRepoFiles({ root: dir, exec: null });
    assert.equal(viaGit, false);
    assert.deepEqual(files.sort(), ["a.ts", "sub/b.ts"]);
  } finally {
    await cleanup();
  }
});

test("walkRoot respects nested .gitignore, negation, and excluded dirs", async () => {
  const { dir, cleanup } = await fixture({
    ".gitignore": "dist/\n*.tmp\n!keep.tmp\n",
    "src/.gitignore": "internal/\n",
    "dist/out.js": "// x",
    "keep.tmp": "x",
    "drop.tmp": "x",
    "src/main.ts": "// x",
    "src/internal/secret.ts": "// x",
    "src/visible.ts": "// x",
    ".git/config": "x",
    ".pi/cache/pi-code-search.json": "{}",
  });
  try {
    const files = await walkRoot(dir);
    assert.deepEqual(files.sort(), ["keep.tmp", "src/main.ts", "src/visible.ts"]);
  } finally {
    await cleanup();
  }
});

test("walkRoot skips directory symlinks but keeps file symlinks", async () => {
  const { dir, cleanup } = await fixture({
    "real/a.ts": "// x",
    "file-link.ts": "// x",
  });
  try {
    const { symlink } = await import("node:fs/promises");
    await symlink(join(dir, "real"), join(dir, "dir-link")); // dir symlink
    await symlink(join(dir, "real", "a.ts"), join(dir, "link.ts")); // file symlink
    const files = await walkRoot(dir);
    assert.ok(!files.includes("dir-link/a.ts"), "dir symlink not followed");
    assert.ok(files.includes("link.ts"), "file symlink kept");
  } finally {
    await cleanup();
  }
});
