import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const prompt = readFileSync(new URL("../prompts/garden.md", import.meta.url), "utf8");

test("garden proposes durable lint rules while keeping its scan read-only and approval-gated", () => {
  for (const sentence of [
    "Do not fix findings during this scan.",
    "At 3 distinct occurrences, draft the exact preventive change and ask for approval.",
    "Prefer an existing lint rule for mechanically checkable smells; if none covers the pattern, propose writing a custom rule in the repository’s native tooling.",
    "Include the detection boundary, a failing example, legitimate passing examples and false-positive risks in a proposed rule.",
    "Use parser and declaration/type information for comment rules; preserve useful documentation, including Go documentation comments, rationale, licenses and directives.",
    "Do not pretend a heuristic or typed AI judgment proves documentation accuracy.",
    "After approval, implement the rule with regression tests and wire it into the normal check command and existing CI gate.",
  ])
    assert.ok(prompt.includes(sentence), sentence);
});
