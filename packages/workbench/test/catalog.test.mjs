import assert from "node:assert/strict";
import { test } from "node:test";

test("command search matches intent, requires every word, and discovers loaded prompts", async () => {
  const { commandCatalog, searchItems } = await import("../catalog.mjs");
  const items = commandCatalog([
    { name: "review", description: "Review the current changes", source: "prompt" },
  ]);
  assert.equal(searchItems(items, "previous conversation")[0].command, "/resume");
  assert.equal(searchItems(items, "file reference")[0].id, "files");
  assert.equal(searchItems(items, "review")[0].command, "/review");
  assert.equal(searchItems(items, "review nonexistent").length, 0);
  assert.equal(items.filter((item) => item.command === "/review").length, 1);
  assert.ok(!items.some((item) => item.command === "/ui"));
  assert.ok(!items.some((item) => item.command === "/subagents"));
  assert.equal(
    commandCatalog([{ name: "subagents" }]).filter((item) => item.command === "/subagents").length,
    1,
  );
});

test("references are plain quoted paths, never auto-expanded attachments or shell commands", async () => {
  const { referenceText } = await import("../catalog.mjs");
  assert.equal(referenceText("/repo", "src/a b.ts", "/repo"), '"src/a b.ts"');
  assert.equal(referenceText("/repo", "a\nb.ts", "/repo/src"), '"../a\\nb.ts"');
});
