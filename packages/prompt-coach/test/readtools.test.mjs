import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { READ_TOOLS, runReadTool } from "../readtools.mjs";

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "coach-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(
    path.join(root, "src", "loader.mjs"),
    "export function load() {\n  retry();\n}\n",
  );
  fs.writeFileSync(path.join(root, "README.md"), "# demo\n");
  fs.writeFileSync(path.join(root, ".env"), "TOKEN=hunter2\n");
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.writeFileSync(path.join(root, "node_modules", "dep.js"), "retry();\n");
  return root;
}

test("the tool list is read-only: no shell, write, edit or exec tool exists", () => {
  const names = READ_TOOLS.map((tool) => tool.function.name).sort();
  assert.deepEqual(names, ["list_dir", "read_file", "search_text"]);
  for (const name of names) assert.doesNotMatch(name, /bash|shell|exec|write|edit|delete|run/);
});

test("read_file returns file text and records nothing else", async () => {
  const root = repo();
  const out = await runReadTool("read_file", { path: "src/loader.mjs" }, root);
  assert.equal(out.ok, true);
  assert.match(out.text, /export function load/);
  assert.equal(out.file, "src/loader.mjs");
});

test("read_file refuses paths outside the repository, including through symlinks", async () => {
  const root = repo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "coach-out-"));
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside");
  fs.symlinkSync(outside, path.join(root, "link"));
  for (const target of ["../x", "/etc/hostname", "link/secret.txt"]) {
    const out = await runReadTool("read_file", { path: target }, root);
    assert.equal(out.ok, false, target);
    assert.match(out.text, /outside the repository/);
  }
});

test("read_file refuses secret-looking files", async () => {
  const root = repo();
  const out = await runReadTool("read_file", { path: ".env" }, root);
  assert.equal(out.ok, false);
  assert.match(out.text, /secret/);
  assert.equal(out.text.includes("hunter2"), false);
});

test("read_file truncates large files and reports a missing one", async () => {
  const root = repo();
  fs.writeFileSync(path.join(root, "big.txt"), "x".repeat(50_000));
  const big = await runReadTool("read_file", { path: "big.txt" }, root);
  assert.equal(big.ok, true);
  assert.ok(big.text.length < 21_000);
  assert.match(big.text, /truncated/);
  const missing = await runReadTool("read_file", { path: "nope.txt" }, root);
  assert.equal(missing.ok, false);
  assert.match(missing.text, /not found/);
});

test("list_dir lists names and skips node_modules and .git", async () => {
  const root = repo();
  fs.mkdirSync(path.join(root, ".git"));
  const out = await runReadTool("list_dir", { path: "." }, root);
  assert.match(out.text, /src\//);
  assert.match(out.text, /README\.md/);
  assert.doesNotMatch(out.text, /node_modules|\.git\b|\.env/);
});

test("search_text finds a literal, skipping node_modules and secret files", async () => {
  const root = repo();
  const out = await runReadTool("search_text", { query: "retry" }, root);
  assert.match(out.text, /src\/loader\.mjs:2:/);
  assert.doesNotMatch(out.text, /node_modules/);
  const none = await runReadTool("search_text", { query: "hunter2" }, root);
  assert.match(none.text, /no matches/);
});

test("an unknown tool name is refused and nothing runs", async () => {
  const root = repo();
  for (const name of ["bash", "write_file", "edit"]) {
    const out = await runReadTool(name, { command: "touch pwned" }, root);
    assert.equal(out.ok, false);
    assert.match(out.text, /not available/);
  }
  assert.equal(fs.existsSync(path.join(root, "pwned")), false);
});
