import { test } from "node:test";
import assert from "node:assert/strict";
import { formatAgentRoster, orchestratorPrompt } from "../orchestrate.mjs";

test("formatAgentRoster lists names and descriptions", () => {
  assert.equal(formatAgentRoster([]), "none");
  assert.equal(
    formatAgentRoster([{ name: "scout", description: "Fast recon" }, { name: "reviewer" }]),
    "- scout — Fast recon\n- reviewer",
  );
});

test("orchestratorPrompt names the main thread and the roster", () => {
  const text = orchestratorPrompt([{ name: "scout", description: "Fast recon" }]);
  assert.match(text, /main thread/);
  assert.match(text, /control creation/i);
  assert.match(text, /- scout — Fast recon/);
  assert.match(text, /Children never spawn children/);
});

test("orchestratorPrompt delegates by context, not by problem type", () => {
  const text = orchestratorPrompt([]);

  assert.doesNotMatch(text, /Do not do that specialist work yourself/i);
  assert.doesNotMatch(text, /Do not edit files yourself while a worker runs/i);
  assert.doesNotMatch(text, /wait for its summary/i);
  assert.doesNotMatch(
    text,
    /A question about external facts, docs, or current info → subagent with a researcher/i,
  );
  assert.doesNotMatch(text, /Recon, review, or a second opinion → subagent/i);

  assert.match(text, /own loop/i);
  assert.match(text, /parallel/i);
  assert.match(text, /flood.*context|context.*flood/i);
  assert.match(text, /fresh eyes|second opinion/i);
  assert.match(text, /review.*verif|verif.*review/i);
});

test("orchestratorPrompt keeps verifier-as-gate and built-in type roster", () => {
  const text = orchestratorPrompt([]);

  assert.match(text, /verifier/i);
  assert.match(text, /treat its verdict, not the implementer's summary, as the gate/i);
  assert.match(text, /reviewer \(findings with path:line\)/);
  assert.match(text, /oracle \(challenge assumptions\)/);
});
