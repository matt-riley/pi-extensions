import { test } from "node:test";
import assert from "node:assert/strict";

import { agentsPrompt } from "../scaffold.mjs";

test("initialization asks for repository-grounded guidance using the site examples", () => {
  const prompt = agentsPrompt({
    dir: "/project/api",
    path: "/project/api/AGENTS.md",
    target: "/project/api/AGENTS.md",
  });
  assert.ok(prompt.includes("https://agents.md/#examples"));
  assert.match(prompt, /development environment/);
  assert.match(prompt, /testing instructions/);
  assert.match(prompt, /pull request/);
  assert.match(prompt, /package manager/);
  assert.match(prompt, /Do not invent/);
  assert.match(prompt, /Only edit/);
});

test("improvement reads current instructions and preserves useful guidance even with Commands", () => {
  const prompt = agentsPrompt({
    dir: "/project",
    path: "/project/AGENTS.MD",
    target: "/shared/rules.md",
  });
  assert.match(prompt, /Read the complete existing file before editing/);
  assert.match(prompt, /Preserve useful existing guidance/);
  assert.match(prompt, /Commands heading is not a reason to stop/);
  assert.match(prompt, /Leave it unchanged if there is nothing useful to improve/);
  assert.ok(prompt.includes(JSON.stringify("/project/AGENTS.MD")));
  assert.ok(prompt.includes(JSON.stringify("/shared/rules.md")));
  assert.match(prompt, /symlink/);
  assert.match(prompt, /Re-read/);
});
