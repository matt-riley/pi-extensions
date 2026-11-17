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

test("each principle sits in its suggested home", () => {
  const feature = read("packages/router/playbooks/feature.md");
  assert.match(feature, /Name the data shape first, and what concurrent actors share, and/);
  assert.match(feature, /Settle product and scope trade-offs by what the user experiences first\./);

  assert.match(
    read("packages/router/playbooks/perf.md"),
    /Explain the number before you trust it: what work it counts and why it is that size\./,
  );
  assert.match(
    read("packages/done-gate/measurement.mjs"),
    /Explain the number \(what work it counts, why it is that size\) before trusting or reporting it\./,
  );

  const design = read(".agents/skills/interface-design/SKILL.md");
  for (const rule of [
    /model the domain as a type, table or state machine so the bad state cannot be written\./,
    /make it idempotent, so running it twice leaves the same state as running it once\./,
    /sketch the design as if the requirement had been there from the start, then compare it with the bolt-on\./,
  ])
    assert.match(design, rule);
});
