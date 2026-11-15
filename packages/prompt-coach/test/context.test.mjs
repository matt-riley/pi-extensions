import { test } from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { gatherProjectContext } from "../context.mjs";

function repo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coach-context-"));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  return root;
}

const names = (context) => context.map((entry) => entry.file);

test("reads the README, the package scripts, an entry file and a test", async () => {
  const root = repo({
    "README.md": "# Site\n",
    "package.json": JSON.stringify({
      name: "site",
      scripts: { dev: "vite" },
      dependencies: { left: "1" },
    }),
    "src/main.ts": "export {};\n",
    "tests/a.test.ts": "// a\n",
  });
  const context = await gatherProjectContext(root);
  assert.deepEqual(names(context), ["README.md", "package.json", "src/main.ts", "tests/a.test.ts"]);
  const pkg = context.find((entry) => entry.file === "package.json").text;
  assert.match(pkg, /"dev": "vite"/);
  assert.doesNotMatch(pkg, /dependencies|left/);
});

test("follows the package.json main field and the first Next-style page", async () => {
  const root = repo({
    "package.json": JSON.stringify({ main: "lib/server.js" }),
    "lib/server.js": "// server\n",
    "app/page.tsx": "// home\n",
  });
  assert.deepEqual(names(await gatherProjectContext(root)), [
    "package.json",
    "lib/server.js",
    "app/page.tsx",
  ]);
});

test("is bounded: at most six files, each cut, and a fixed total", async () => {
  const big = "x".repeat(50_000);
  const root = repo({
    "README.md": big,
    "package.json": JSON.stringify({ scripts: { build: big } }),
    "index.ts": big,
    "src/index.ts": big,
    "src/main.ts": big,
    "test/a.test.mjs": big,
    "test/b.test.mjs": big,
    "test/c.test.mjs": big,
  });
  const context = await gatherProjectContext(root);
  assert.ok(context.length <= 6);
  for (const entry of context) assert.ok(entry.text.length <= 3_000);
  assert.ok(context.reduce((sum, entry) => sum + entry.text.length, 0) <= 12_000);
});

test("never opens secret files, binary files or paths outside the repo", async () => {
  const root = repo({
    "README.md": "\u0000binary",
    ".env": "TOKEN=hunter2\n",
    "package.json": "{not json",
  });
  const context = await gatherProjectContext(root);
  assert.deepEqual(context, []);
});

test("a missing or unreadable directory yields nothing, not an error", async () => {
  assert.deepEqual(await gatherProjectContext("/definitely/not/here"), []);
  assert.deepEqual(await gatherProjectContext(""), []);
});
