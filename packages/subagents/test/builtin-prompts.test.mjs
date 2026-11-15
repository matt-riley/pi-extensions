// The shipped scout and oracle prompts are the product: these tests read the real
// files, so a rewrite cannot quietly drop a rule or the brief handling.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const prompt = (name) =>
  readFileSync(fileURLToPath(new URL(`../agents/${name}.md`, import.meta.url)), "utf8");

for (const name of ["scout", "oracle"]) {
  test(`${name} keeps its hard rules`, () => {
    const text = prompt(name);
    assert.match(text, /Do not edit files\./);
    assert.match(text, /Do not spawn other agents\./);
    assert.match(text, /Bash is read-only inspection only\./);
  });

  test(`${name} reports what its brief leaves out instead of guessing`, () => {
    const text = prompt(name);
    assert.match(text, /brief/i);
    assert.match(text, /cannot see|missing/i);
    assert.match(text, /do not guess|instead of guessing/i);
  });

  test(`${name} does the task itself rather than handing it on`, () => {
    assert.match(prompt(name), /do the task yourself|do the work yourself/i);
  });
}

test("oracle checks the brief's claims against the code", () => {
  assert.match(prompt("oracle"), /check each claim/i);
});

test("scout names how it knows, so the parent can repeat the check", () => {
  assert.match(prompt("scout"), /search or command|how you know/i);
});
