// The tool as the agent calls it: a fake pi, a real temporary repo with no git.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import piCodeSearchExtension from "../index.ts";

function setup(files) {
  const dir = mkdtempSync(join(tmpdir(), "code-search-ext-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  const tools = {};
  piCodeSearchExtension({
    registerTool: (tool) => {
      tools[tool.name] = tool;
    },
    exec: async () => ({ code: 128, stdout: "", stderr: "not a git repository" }),
  });
  const ctx = { cwd: dir, hasUI: false };
  const search = async (params) =>
    (await tools.code_search.execute("call", params, undefined, undefined, ctx)).content[0].text;
  return { dir, tools, search, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const SOURCE = [
  "export function retryDelay(attempt) {",
  "  const base = 100;",
  "  return base * 2 ** attempt;",
  "}",
  "",
  "export function other() {",
  "  return retryDelay(1);",
  "}",
].join("\n");

test("context=N returns the lines around each hit, ready to edit from", async () => {
  const t = setup({ "src/retry.mjs": SOURCE });
  try {
    const text = await t.search({ query: "base *", context: 1 });
    assert.match(text, /\[context=1\]/);
    assert.match(text, /2 \|   const base = 100;/);
    assert.match(text, /> 3 \|   return base \* 2 \*\* attempt;/);
    assert.match(text, /4 \| }/);
  } finally {
    t.done();
  }
});

test("without context a hit is the one line, as before", async () => {
  const t = setup({ "src/retry.mjs": SOURCE });
  try {
    const text = await t.search({ query: "base *" });
    assert.match(text, /src\/retry\.mjs:3:/);
    assert.doesNotMatch(text, /\|/);
  } finally {
    t.done();
  }
});

test("two searches run side by side each come back labelled and complete", async () => {
  const t = setup({ "src/retry.mjs": SOURCE, "docs/notes.md": "retryDelay is documented here\n" });
  try {
    const [inSrc, inDocs] = await Promise.all([
      t.search({ query: "retryDelay", path: "src", context: 1 }),
      t.search({ query: "retryDelay", path: "docs" }),
    ]);
    assert.match(inSrc, /\[path=src, context=1\]/);
    assert.match(inSrc, /src\/retry\.mjs/);
    assert.doesNotMatch(inSrc, /docs\/notes\.md/);
    assert.match(inDocs, /\[path=docs\]/);
    assert.match(inDocs, /docs\/notes\.md/);
  } finally {
    t.done();
  }
});

test("a cursor from a search without context still pages with context set", async () => {
  const many = Array.from({ length: 12 }, (_, i) => `const v${i} = "marker";`).join("\n");
  const t = setup({ "a.mjs": many });
  try {
    const first = await t.search({ query: "marker", maxResults: 3 });
    const cursor = /cursor="([^"]+)"/.exec(first)?.[1];
    assert.ok(cursor, first);
    const next = await t.search({ query: "marker", maxResults: 3, cursor, context: 1 });
    assert.doesNotMatch(next, /failed/);
    assert.match(next, /\|/);
  } finally {
    t.done();
  }
});
