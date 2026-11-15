import { test } from "node:test";
import assert from "node:assert/strict";

import { describePrompt, promptLine, sectionSizes, toolFootprint } from "../prompt-sections.mjs";
import { estimateTokens } from "../segment.mjs";

test("sectionSizes estimates each non-empty string section, largest first", () => {
  const sections = {
    plan_mode: "word ".repeat(400),
    router_playbook: "short note",
    empty: "   ",
    notText: 42,
  };
  const sizes = sectionSizes(sections);
  assert.deepEqual(
    sizes.map((s) => s.name),
    ["plan_mode", "router_playbook"],
  );
  assert.equal(sizes[0].tokens, estimateTokens(sections.plan_mode));
  assert.ok(sizes[0].tokens > sizes[1].tokens);
});

test("sectionSizes tolerates a missing or odd sections value", () => {
  assert.deepEqual(sectionSizes(undefined), []);
  assert.deepEqual(sectionSizes(null), []);
  assert.deepEqual(sectionSizes("x"), []);
});

test("toolFootprint counts only active tools the model is shown", () => {
  const tools = [
    {
      name: "read",
      description: "Read a file",
      parameters: { type: "object" },
      exposure: "direct",
    },
    { name: "later", description: "x".repeat(2000), exposure: "deferred" },
    { name: "off", description: "y".repeat(2000), exposure: "direct" },
    { name: "secret", description: "z".repeat(2000), exposure: "hidden" },
  ];
  const result = toolFootprint(tools, ["read", "later", "secret"]);
  assert.equal(result.count, 1);
  assert.ok(result.tokens > 0 && result.tokens < 100);
});

test("toolFootprint with no tool list is empty, not an error", () => {
  assert.deepEqual(toolFootprint(undefined, undefined), { count: 0, tokens: 0 });
});

test("describePrompt labels everything an estimate and says when nothing was captured", () => {
  const none = describePrompt({ sections: null, tools: [], active: [] });
  assert.equal(none.estimate, true);
  assert.equal(none.sections, null);
  assert.match(none.note, /estimate/i);
  assert.match(none.note, /no request yet/i);

  const some = describePrompt({
    sections: [{ name: "plan_mode", tokens: 300 }],
    tools: [],
    active: [],
  });
  assert.equal(some.estimate, true);
  assert.equal(some.sectionTokens, 300);
  assert.deepEqual(some.sections, [{ name: "plan_mode", tokens: 300 }]);
  assert.match(some.note, /estimate/i);
});

test("promptLine is one short line for the info command", () => {
  const line = promptLine(
    describePrompt({
      sections: [
        { name: "plan_mode", tokens: 300 },
        { name: "router_playbook", tokens: 120 },
        { name: "orchestrator", tokens: 90 },
        { name: "a", tokens: 5 },
      ],
      tools: [{ name: "read", description: "Read", exposure: "direct" }],
      active: ["read"],
    }),
  );
  assert.match(line, /^prompt ≈/);
  assert.match(line, /plan_mode 300/);
  assert.doesNotMatch(line, /\n/);
  assert.match(line, /estimate/);
  assert.match(promptLine(describePrompt({ sections: null })), /prompt sections: not seen yet/);
});
