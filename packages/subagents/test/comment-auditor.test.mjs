// The comment-auditor prompt is the product: these tests read the shipped file
// through the real discovery path, so a rewrite cannot drop a class or a rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAgents, isWriteCapable, resolveChildTools } from "../discover.mjs";

const builtinDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agents");
const auditor = () => {
  const agent = discoverAgents({ builtinDir }).agents.find((a) => a.name === "comment-auditor");
  assert.ok(agent, "comment-auditor is discovered as a builtin");
  return agent;
};

test("comment-auditor is read-only with allowlisted bash", () => {
  const agent = auditor();
  assert.equal(agent.source, "builtin");
  assert.equal(isWriteCapable(agent), false);
  const { tools } = resolveChildTools(agent);
  assert.ok(!tools.includes("edit") && !tools.includes("write"), tools.join(","));
  assert.match(agent.systemPrompt, /Do not edit files\./);
  assert.match(agent.systemPrompt, /Do not spawn other agents\./);
  assert.match(agent.systemPrompt, /Bash is read-only inspection only\./);
});

test("comment-auditor sorts every comment into keep, delete or encode", () => {
  const text = auditor().systemPrompt;
  assert.match(text, /Classify every comment as exactly one of:/);
  assert.match(
    text,
    /\*\*keep\*\*: a legal or license header; documentation of a public API; a constraint imposed by something this code cannot change/,
  );
  assert.match(text, /a link to an issue or ticket/);
  assert.match(text, /\*\*delete\*\*: it restates the code, narrates a step/);
  assert.match(
    text,
    /\*\*encode\*\*: it states a rule a type, test, lint or assertion could enforce/,
  );
  assert.match(text, /Name the cheapest encoding and where it goes\./);
  assert.match(text, /A suppression without a reason is never keep\./);
});

test("comment-auditor grounds each call and scopes to the diff by default", () => {
  const text = auditor().systemPrompt;
  assert.match(text, /If it names no scope, audit the comments the current diff adds or changes/);
  assert.match(text, /do not guess at it\. Do the work yourself\./);
  assert.match(text, /name the line that shows it\./);
  assert.match(text, /`path:line` \*\*keep\|delete\|encode\*\*/);
});
