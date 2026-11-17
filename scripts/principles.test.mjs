// Engineering principles that live inside the prompts where they apply, and
// the autonomy rule shared by the write-capable and verifying children. Each
// assertion is the sentence the rule states, not a keyword.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (file) => readFileSync(path.join(root, file), "utf8");

test("worker and verifier hold the brief's bar and report base problems", () => {
  for (const [file, subject] of [
    ["packages/subagents/agents/worker.md", "your change"],
    ["packages/subagents/agents/verifier.md", "the change"],
  ]) {
    const text = read(file);
    assert.match(text, /The bar in the task is the whole bar: add no gate above it\./, file);
    assert.ok(
      text.includes(
        `A problem the base already had before ${subject} is reported in one line, not fixed.`,
      ),
      file,
    );
  }
});
