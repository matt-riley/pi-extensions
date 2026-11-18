import assert from "node:assert/strict";
import { test } from "node:test";
import { qualityPrompt } from "../workflow.mjs";

test("requests repository-wide remediation and durable native linting, not just comment review", () => {
  const prompt = qualityPrompt({ root: "/repo with spaces", checks: [] });
  for (const sentence of [
    "Inspect the whole repository, not just the current diff or comments.",
    "Fix substantiated code smells while preserving observable behavior and public APIs.",
    "Reuse existing lint rules first; write a custom rule only for a missing, mechanically checkable smell.",
    "When authoring a custom rule, read the `lint-rules` skill and start TypeScript or Go from the scaffold command it names, which writes a passing and failing fixture.",
    "Wire prevention into the repository’s normal check command and existing CI gate.",
    "Use the language’s native parser and declaration/type information to distinguish documentation from ordinary comments.",
    "Preserve Go documentation comments attached to packages, declarations, fields and methods, and preserve JSDoc, Rust doc comments, Python docstrings, licenses and tool directives.",
    "Never infer documentation accuracy from its prefix or the presence of a symbol name.",
    "Uncertain or unavailable judgments must preserve the comment and report it for review.",
    "Do not install tools or dependencies, publish, push, merge, change global Pi configuration, or remove public APIs without explicit approval.",
    "Rerun both applicable CLIs and the repository’s lint, type, test and verification commands after the final edit.",
  ])
    assert.ok(prompt.includes(sentence), sentence);
  assert.ok(prompt.includes(JSON.stringify("/repo with spaces")));
});
