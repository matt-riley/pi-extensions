import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { VERDICT_ENTRY } from "../../../shared/verdict.mjs";
import {
  ENTRY_TYPES,
  installDecisionRows,
  JEV_DECISION,
  PROMPT_COACH_DECISION,
  ROUTER_DECISION,
  ROUTER_PLAYBOOK,
  rowFor,
  rowLines,
  rowMode,
} from "../rows.mjs";

const root = path.resolve(import.meta.dirname, "../../..");
const source = (file) => readFileSync(path.join(root, file), "utf8");
const allText = (row) => [row.head, ...row.details].join("\n");

test("each entry type is the one its writer appends", () => {
  assert.match(source("packages/router/index.ts"), /appendEntry\?\.\("router-decision"/);
  assert.match(source("packages/router/index.ts"), /appendEntry\?\.\("router-playbook"/);
  assert.match(
    source("packages/prompt-coach/index.ts"),
    /appendEntry\?\.\("prompt-coach-decision"/,
  );
  assert.match(source("shared/jev-ledger.mjs"), /appendEntry\("jev-decision"/);
  assert.match(source("packages/subagents/index.ts"), /appendEntry\(VERDICT_ENTRY/);
  assert.deepEqual(ENTRY_TYPES, [
    ROUTER_DECISION,
    ROUTER_PLAYBOOK,
    JEV_DECISION,
    VERDICT_ENTRY,
    PROMPT_COACH_DECISION,
  ]);
});

test("rowMode reads off, all and the default", () => {
  assert.equal(rowMode(undefined), "changes");
  assert.equal(rowMode("0"), "off");
  assert.equal(rowMode("off"), "off");
  assert.equal(rowMode(" ALL "), "all");
  assert.equal(rowMode("offline"), "changes");
});

test("a router escalation is one row naming the model, difficulty and tier", () => {
  const row = rowFor(ROUTER_DECISION, {
    outcome: "escalated",
    from: "anthropic/claude-sonnet-5-5",
    to: "anthropic/claude-opus-5-5",
    toThinking: "high",
    difficulty: 0.723,
    tier: "frontier",
    threshold: 0.6,
    boundary: true,
    contextTokens: 41200,
    latencyMs: 312.4,
  });
  assert.equal(row.tag, "router");
  assert.equal(row.head, "escalated → claude-opus-5-5@high · difficulty 0.72 · frontier");
  assert.deepEqual(row.details, [
    "from: anthropic/claude-sonnet-5-5",
    "to: anthropic/claude-opus-5-5",
    "threshold: 0.60",
    "new task: yes",
    "context: 41k tokens",
    "judged in: 312ms",
  ]);
});

test("a held router decision draws nothing unless every row is asked for", () => {
  const held = { outcome: "held", from: "p/base", difficulty: 0.2, tier: "base" };
  assert.equal(rowFor(ROUTER_DECISION, held), null);
  assert.equal(rowFor(ROUTER_DECISION, { outcome: "no-frontier-model" }), null);
  assert.equal(rowFor(ROUTER_DECISION, held, "all").head, "held on base · difficulty 0.20 · base");
});

test("a failed router judge is a warning that keeps the model it stayed on", () => {
  const row = rowFor(ROUTER_DECISION, {
    outcome: "judge-failed",
    from: "p/base",
    error: "timeout",
  });
  assert.equal(row.tone, "warning");
  assert.equal(row.head, "judge failed, stayed on base");
  assert.ok(row.details.includes("error: timeout"));
});

test("a playbook row shows only when one was loaded or pinned", () => {
  assert.equal(rowFor(ROUTER_PLAYBOOK, { type: "none", boundary: true }), null);
  assert.equal(rowFor(ROUTER_PLAYBOOK, { type: "debug", boundary: true }).head, "playbook debug");
  assert.equal(
    rowFor(ROUTER_PLAYBOOK, { type: "none", pinned: true }).head,
    "no playbook · pinned",
  );
});

const guardrail = {
  v: 1,
  feature: "guardrail",
  model: "jev-1.13.0",
  requestedModel: "jev-1.13.0",
  questions: [
    { id: "destructive", kind: "noul" },
    { id: "blast_radius", kind: "score" },
  ],
  answers: {
    destructive: { type: "noul", noul: 0.08 },
    blast_radius: { type: "score", score: 0.88, confidence: 0.13, probabilities: { 0: 0.5 } },
    pick: { type: "choice", choice: 1 },
  },
  latencyMs: 178,
  transport: "classify",
  redactions: 0,
  privacyRedactions: 1,
  outcome: "ok",
};

test("guardrail and done-gate answers draw their scores; other answers stay quiet", () => {
  assert.equal(
    rowFor(JEV_DECISION, guardrail).head,
    "guardrail · destructive 0.08, blast_radius 0.88, pick #1",
  );
  const doneGate = {
    ...guardrail,
    feature: "done-gate",
    answers: { asserts_verified: { noul: 0.93 }, claims_remote: { noul: 0.14 } },
  };
  assert.equal(
    rowFor(JEV_DECISION, doneGate).head,
    "done-gate · asserts_verified 0.93, claims_remote 0.14",
  );
  assert.equal(rowFor(JEV_DECISION, { ...guardrail, feature: "safe-compact" }), null);
  assert.equal(rowFor(JEV_DECISION, { ...guardrail, feature: "diagnosis-nudge" }), null);
  assert.equal(
    rowFor(JEV_DECISION, { ...guardrail, feature: "router", answers: null }, "all").head,
    "router · answered",
  );
});

test("a failed Jev call is an error row whatever the feature", () => {
  assert.equal(
    rowFor(JEV_DECISION, { ...guardrail, feature: "safe-compact", outcome: "error" }).tone,
    "error",
  );
  const failed = rowFor(JEV_DECISION, {
    ...guardrail,
    answers: null,
    outcome: "error",
    errorClass: "http",
    status: 503,
  });
  assert.equal(failed.tone, "error");
  assert.equal(failed.head, "guardrail failed: http (HTTP 503) · 178ms");
});

test("an answered Jev row's details list numbers, never criteria labels", () => {
  const row = rowFor(JEV_DECISION, guardrail);
  assert.deepEqual(row.details, [
    "model: jev-1.13.0",
    "transport: classify",
    "answered in: 178ms",
    "questions: destructive (noul), blast_radius (score)",
    "destructive: noul 0.08",
    "blast_radius: score 0.88, confidence 0.13",
    "pick: choice #1",
    "secrets redacted: 0",
    "private values redacted: 1",
  ]);
});

test("model drift shows even on an answered Jev call", () => {
  const row = rowFor(JEV_DECISION, {
    ...guardrail,
    model: "jev-2.0.0",
    modelDrift: true,
    tunedModel: "jev-1.13.0",
  });
  assert.equal(row.tone, "warning");
  assert.match(row.head, /model drift: jev-2\.0\.0/);
  assert.ok(row.details.includes("requested: jev-1.13.0"));
  assert.ok(row.details.includes("tuned on: jev-1.13.0"));
});

test("a verifier verdict names the verdict and the commit it ended on", () => {
  const row = rowFor(VERDICT_ENTRY, {
    verdict: "verified",
    head: "0123456789abcdef0123",
    patchId: "fedcba9876543210fedcba",
    base: "origin/main",
    at: "2026-11-17T10:00:00.000Z",
    id: "verifier-1",
  });
  assert.equal(row.tone, "success");
  assert.equal(row.head, "verified · at 0123456789ab");
  assert.deepEqual(row.details, [
    "patch id: fedcba9876543210",
    "base: origin/main",
    "run: verifier-1",
    "at: 2026-11-17T10:00:00.000Z",
  ]);
  assert.equal(rowFor(VERDICT_ENTRY, { verdict: "failed" }).tone, "error");
  assert.equal(rowFor(VERDICT_ENTRY, {}).head, "unreadable");
});

test("a prompt-coach row never prints the prompt, the rewrite, the probe or file names", () => {
  const secret = "SECRET_PROMPT_TEXT";
  const row = rowFor(PROMPT_COACH_DECISION, {
    at: 1,
    version: 3,
    original: `${secret} original`,
    candidate: `${secret} candidate`,
    placed: `${secret} placed`,
    action: "rewritten",
    intentProbability: 0.81,
    intentError: null,
    rewriteError: `${secret} quoted in an error`,
    filesRead: [`${secret}.md`, "package.json"],
    probe: { branch: secret, commit: secret },
    model: "gpt-5.6-terra",
    subscription: true,
    concise: false,
  });
  assert.equal(row.head, "rewritten · intent 0.81 · gpt-5.6-terra");
  assert.deepEqual(row.details, [
    "concise style: no",
    "subscription: yes",
    "files read: 2",
    "rewrite failed",
  ]);
  assert.doesNotMatch(allText(row), new RegExp(secret));
});

test("stored strings lose control characters and long ones are cut", () => {
  const row = rowFor(VERDICT_ENTRY, {
    verdict: "verified",
    base: `\u001b[2Jmain\nnext${"x".repeat(200)}`,
  });
  const base = row.details.find((line) => line.startsWith("base: "));
  assert.ok([...base].every((char) => char.charCodeAt(0) >= 0x20));
  assert.ok(base.startsWith("base: [2Jmain next"));
  assert.ok(base.length <= "base: ".length + 80);
});

test("unknown types, missing data and off mode draw nothing", () => {
  assert.equal(rowFor("something-else", { a: 1 }), null);
  assert.equal(rowFor(VERDICT_ENTRY, undefined), null);
  assert.equal(rowFor(VERDICT_ENTRY, { verdict: "verified" }, "off"), null);
});

test("rowLines is one line collapsed and adds details when expanded", () => {
  const row = { tag: "verifier", tone: "success", head: "verified", details: ["base: main"] };
  const theme = { fg: (color, text) => `<${color}>${text}</${color}>` };
  const cut = [];
  const truncate = (text, width) => {
    cut.push(width);
    return text;
  };
  assert.deepEqual(rowLines(row, { width: 40, theme, truncate }), [
    " <accent>verifier</accent> <success>verified</success>",
  ]);
  assert.deepEqual(rowLines(row, { expanded: true, width: 40, theme, truncate }), [
    " <accent>verifier</accent> <success>verified</success>",
    "   <dim>base: main</dim>",
  ]);
  assert.ok(cut.every((width) => width === 40));
  assert.deepEqual(rowLines(row, {}), [" verifier verified"]);
});

function fakePi() {
  const renderers = new Map();
  return {
    renderers,
    registerEntryRenderer: (type, renderer) => renderers.set(type, renderer),
  };
}

test("install registers one renderer per type and returns undefined for quiet entries", () => {
  const pi = fakePi();
  assert.equal(installDecisionRows(pi, { truncateToWidth: (text) => text }, {}), true);
  assert.deepEqual([...pi.renderers.keys()], ENTRY_TYPES);
  const render = pi.renderers.get(ROUTER_DECISION);
  assert.equal(render({ data: { outcome: "held" } }, { expanded: false }, {}), undefined);
  const component = render(
    { data: { outcome: "escalated", to: "p/big" } },
    { expanded: false },
    {},
  );
  assert.deepEqual(component.render(60), [" router escalated → big"]);
  assert.doesNotThrow(() => component.invalidate());
});

test("install does nothing when switched off or when pi has no entry renderers", () => {
  const pi = fakePi();
  assert.equal(installDecisionRows(pi, {}, { PI_DECISION_ROWS: "0" }), false);
  assert.equal(pi.renderers.size, 0);
  assert.equal(installDecisionRows({}, {}, {}), false);
});
