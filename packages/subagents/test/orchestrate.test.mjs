import { test } from "node:test";
import assert from "node:assert/strict";
import {
  formatAgentRoster,
  orchestratorPrompt,
  TASK_DESCRIPTION,
  TOOL_DESCRIPTION,
} from "../orchestrate.mjs";

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

test("a brief stands on its own: plan, paths, conventions and how to verify", () => {
  const text = orchestratorPrompt([]);
  assert.match(text, /plan this job is part of/i);
  assert.match(text, /conventions/i);
  assert.match(text, /exact command/i);
  assert.match(text, /as discussed|the file above/i, "names the phrases that give a brief away");
});

test("it says not to delegate a one-reply job or the whole assignment", () => {
  const text = orchestratorPrompt([]);
  assert.match(text, /one reply/i);
  assert.match(text, /whole (assignment|job)/i);
  assert.match(text, /own the plan/i);
});

test("child results are summarised for a user who cannot see them", () => {
  const text = orchestratorPrompt([]);
  assert.match(text, /user cannot see/i);
  assert.match(text, /summari[sz]e each/i);
  assert.match(text, /still doing/i);
});

test("the tool text carries the same brief checklist", () => {
  for (const text of [TOOL_DESCRIPTION, TASK_DESCRIPTION]) {
    assert.match(text, /plan/i);
    assert.match(text, /conventions/i);
    assert.match(text, /verify/i);
  }
  assert.match(TOOL_DESCRIPTION, /one reply/i);
});
