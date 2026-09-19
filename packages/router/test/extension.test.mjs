// End-to-end tests for the router entry: a fake pi, a fake session branch and a
// canned judgement drive the real before_agent_start handler. No network.
//
// The behaviours worth pinning are the ones the measurements argued for: hold
// the decision while a task continues, escalate only above the threshold, step
// back down only from a model the router chose, and never treat a missing
// judgement as a reason to spend less.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import piRouterExtension from "../index.ts";
import { readFileSync } from "node:fs";
import { DIFFICULTY_THRESHOLD } from "../model-battery.mjs";

const LUNA = { provider: "openai-codex", id: "gpt-5.6-luna" };
// The Codex frontier models hold 272K while the deepseek base holds 1M, which is
// the collision the context guard exists for.
const ASTRA = { provider: "openai-codex", id: "gpt-6-astra", contextWindow: 272000 };
const SOL = { provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 272000 };

const ENV = { PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD, PI_ROUTER: process.env.PI_ROUTER };

beforeEach(() => {
  delete process.env.PI_SUBAGENT_CHILD;
  delete process.env.PI_ROUTER;
});

function harness({
  difficulty = 0.7,
  available = [LUNA, ASTRA, SOL],
  scopedModels,
  model = LUNA,
  setModelOk = true,
  askImpl,
} = {}) {
  const handlers = {};
  const commands = {};
  const notifications = [];
  const statuses = [];
  const entries = [];
  const setModelCalls = [];
  const branch = [];
  let askCalls = 0;
  // pi.setModel changes the session model, so the fake session follows it.
  let currentModel = model;

  const pi = {
    on: (name, handler) => {
      (handlers[name] ??= []).push(handler);
    },
    registerCommand: (name, def) => {
      commands[name] = def;
    },
    appendEntry: (customType, data) => entries.push({ customType, data }),
    setModel: async (value) => {
      setModelCalls.push(value);
      if (setModelOk) currentModel = value;
      return setModelOk;
    },
  };

  const ctx = {
    cwd: "/Users/mattriley/repo",
    hasUI: true,
    get model() {
      return currentModel;
    },
    scopedModels,
    modelRegistry: { getAvailable: () => available },
    sessionManager: { getBranch: () => branch },
    ui: {
      notify: (title, level) => notifications.push({ title, level }),
      setStatus: (id, text) => statuses.push({ id, text }),
    },
  };

  const judge =
    askImpl ?? (async () => ({ answers: { difficulty: { type: "score", score: difficulty } } }));
  piRouterExtension(pi, {
    // Count every judgement, injected or not: several tests assert on the call
    // count and would otherwise always see zero.
    ask: async (...args) => {
      askCalls++;
      return judge(...args);
    },
  });

  return {
    branch,
    notifications,
    statuses,
    entries,
    setModelCalls,
    askCount: () => askCalls,
    run: (prompt, overrides = {}) =>
      handlers.before_agent_start[0]({ prompt }, { ...ctx, ...overrides }),
    /** Append a completed turn to the session branch, as pi would. */
    say: (prompt, { assistant = "done", failures = 0 } = {}) => {
      branch.push({
        type: "message",
        message: { role: "user", content: [{ type: "text", text: prompt }] },
      });
      branch.push({
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: assistant }] },
      });
      for (let i = 0; i < failures; i++) {
        branch.push({
          type: "message",
          message: { role: "toolResult", toolName: "bash", isError: true },
        });
      }
    },
    command: (args) => commands.route.handler(args, ctx),
    selectModel: (next, source = "set") =>
      handlers.model_select?.[0]?.({ model: next, previousModel: null, source }, ctx),
  };
}

// ---------------------------------------------------------------------------

test("escalates to the frontier model when the task rates hard", async () => {
  const h = harness({ difficulty: 2.2 });
  await h.run("audit the routing design and tell me what is wrong with it");
  assert.equal(h.setModelCalls.length, 1);
  assert.equal(h.setModelCalls[0], ASTRA, "first pattern wins");
  assert.match(h.notifications.at(-1).title, /difficulty 2\.20/);
});

test("holds the current model when the task rates easy", async () => {
  const h = harness({ difficulty: 0.6 });
  await h.run("what does this function do");
  assert.equal(h.setModelCalls.length, 0);
});

test("a continuation is not re-judged: the decision is held for the task", async () => {
  const h = harness({ difficulty: 0.6 });
  await h.run("start work on the parser rewrite in the guardrail package");
  h.say("start work on the parser rewrite in the guardrail package");
  await h.run("push");
  assert.equal(h.askCount(), 1, "one judgement for the task, not one per turn");
});

test("a task that is failing gets re-judged", async () => {
  const h = harness({ difficulty: 2.4 });
  await h.run("fix the failing parser tests in the guardrail package");
  h.say("fix the failing parser tests in the guardrail package", { failures: 2 });
  await h.run("keep going");
  assert.equal(h.askCount(), 2);
  assert.equal(h.setModelCalls.length, 1);
});

test("steps back down at a new task, but only from a model it chose", async () => {
  const mutable = { difficulty: 2.2 };
  const h = harness({
    askImpl: async () => ({
      answers: { difficulty: { type: "score", score: mutable.difficulty } },
    }),
  });

  await h.run("audit the routing design and tell me what is wrong with it");
  assert.equal(h.setModelCalls.length, 1);
  assert.equal(h.setModelCalls[0], ASTRA);
  h.say("audit the routing design and tell me what is wrong with it");

  // A new task, rated easy: the router takes its own escalation back.
  mutable.difficulty = 0.4;
  await h.run("now explain how the deploy pipeline works end to end for a new reader");
  assert.equal(h.setModelCalls.length, 2);
  assert.equal(h.setModelCalls[1], LUNA);
  assert.match(h.notifications.at(-1).title, /back to openai-codex\/gpt-5\.6-luna/);
});

test("never steps down a model the user chose", async () => {
  const h = harness({ difficulty: 0.4, model: ASTRA });
  await h.run("explain what this repository does");
  assert.equal(h.setModelCalls.length, 0);
});

test("a failed judgement keeps the model that was working", async () => {
  const h = harness({
    askImpl: async () => {
      throw new Error("TYPESAFE_API_KEY is not set");
    },
  });
  await h.run("audit the routing design");
  assert.equal(h.setModelCalls.length, 0);
});

test("an unusable rating is not a decision to spend less", async () => {
  const h = harness({
    askImpl: async () => ({ answers: { difficulty: { type: "score", score: null } } }),
  });
  await h.run("audit the routing design");
  assert.equal(h.setModelCalls.length, 0);
});

test("no available frontier model says so instead of guessing", async () => {
  const h = harness({ difficulty: 2.6, available: [LUNA] });
  await h.run("audit the routing design");
  assert.equal(h.setModelCalls.length, 0);
  assert.match(h.notifications.at(-1).title, /no frontier model is available/);
});

test("missing authentication is reported, not retried", async () => {
  const h = harness({ difficulty: 2.6, setModelOk: false });
  await h.run("audit the routing design");
  assert.equal(h.setModelCalls.length, 1);
  assert.match(h.notifications.at(-1).title, /no authentication/);
  assert.equal(h.notifications.at(-1).level, "error");
});

test("a scoped session is never escaped", async () => {
  // The user pinned this session to one model; routing must stay inside it.
  const h = harness({ difficulty: 2.6, scopedModels: [{ model: LUNA }], available: [LUNA, ASTRA] });
  await h.run("audit the routing design");
  assert.equal(h.setModelCalls.length, 0, "astra is available but not scoped into this session");
});

test("refuses to escalate into a window the session would not fit", async () => {
  // Context read 452k on the p90 turn here; gpt-6-astra holds 272k. Switching
  // would compact the session, which is the opposite of what escalation is for.
  const h = harness({ difficulty: 2.6 });
  h.say("start on the big refactor task in this repository please", {
    assistant: "Working through it.",
  });
  h.branch.push({
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "still going" }],
      usage: { input: 2000, cacheRead: 450000 },
    },
  });
  await h.run("and now finish the analysis of the whole thing for me");
  assert.equal(h.setModelCalls.length, 0);
  assert.match(
    h.notifications.at(-1).title,
    /staying on .* reads 452k tokens and no available frontier model fits it/,
  );
});

test("escalates when the session still fits the frontier window", async () => {
  const h = harness({ difficulty: 2.6 });
  h.say("start on the big refactor task in this repository please", {
    assistant: "Working through it.",
  });
  h.branch.push({
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "still going" }],
      usage: { input: 2000, cacheRead: 100000 },
    },
  });
  await h.run("and now finish the analysis of the whole thing for me");
  assert.equal(h.setModelCalls.length, 1);
});

test("every judgement is recorded as a non-context entry", async () => {
  // The report joins these to what happened later: a held decision followed by
  // a manual escalation is a miss, an escalation followed by a retreat is not.
  const h = harness({ difficulty: 2.2 });
  await h.run("audit the routing design and tell me what is wrong with it");
  const entry = h.entries.find((e) => e.customType === "router-decision");
  assert.ok(entry, JSON.stringify(h.entries));
  assert.equal(entry.data.outcome, "escalated");
  assert.equal(entry.data.to, "openai-codex/gpt-6-astra");
  assert.equal(entry.data.from, "openai-codex/gpt-5.6-luna");
  assert.ok(entry.data.difficulty >= 2);
  assert.equal(typeof entry.data.latencyMs, "number");
});

test("a held judgement records its rating and threshold", async () => {
  const h = harness({ difficulty: 0.8 });
  await h.run("what does this function do");
  const entry = h.entries.find((e) => e.customType === "router-decision");
  assert.equal(entry.data.outcome, "held");
  assert.equal(entry.data.difficulty, 0.8);
  assert.equal(entry.data.threshold, 1.5);
});

test("a failed judgement is recorded too", async () => {
  const h = harness({
    askImpl: async () => {
      throw new Error("judge down");
    },
  });
  await h.run("audit the routing design");
  assert.equal(
    h.entries.find((e) => e.customType === "router-decision").data.outcome,
    "judge-failed",
  );
});

test("the footer status says what the router is doing", async () => {
  const h = harness({ difficulty: 2.2 });
  // The status line is how a loaded-but-holding router is told apart from one
  // that was never loaded, which is exactly what a stale session looked like.
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  assert.match(source, /setStatus\(ctx, state\.enabled \? "router: armed" : "router: off"\)/);
  await h.run("audit the routing design and tell me what is wrong with it");
  assert.ok(
    h.statuses.some((entry) => /^router: gpt-6-astra @ 2\.2$/.test(entry.text)),
    JSON.stringify(h.statuses),
  );
});

test("/route off disarms it, /route on re-arms it", async () => {
  const h = harness({ difficulty: 2.6 });
  await h.command("off");
  await h.run("audit the routing design");
  assert.equal(h.askCount(), 0);
  await h.command("on");
  await h.run("audit the routing design again properly");
  assert.equal(h.askCount(), 1);
});

test("/route status reports what it has been doing", async () => {
  const h = harness({ difficulty: 2.2 });
  await h.run("audit the routing design");
  await h.command("status");
  const status = h.notifications.at(-1).title;
  assert.match(status, /Router on/);
  assert.match(status, /1 judged/);
  assert.match(status, /1 escalated/);
  assert.match(status, new RegExp(`threshold ${DIFFICULTY_THRESHOLD}`));
});

test("a subagent child is left alone", async () => {
  process.env.PI_SUBAGENT_CHILD = "1";
  const h = harness({ difficulty: 2.6 });
  await h.run("audit the routing design");
  assert.equal(h.askCount(), 0);
  assert.equal(h.setModelCalls.length, 0);
});

test("PI_ROUTER=off disarms it before the first turn", async () => {
  process.env.PI_ROUTER = "off";
  const h = harness({ difficulty: 2.6 });
  await h.run("audit the routing design");
  assert.equal(h.askCount(), 0);
});

test.after?.(() => {
  for (const [key, value] of Object.entries(ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// ---------------------------------------------------------------------------
// The audit's findings, pinned

test("the judgement budget resets at a task boundary", async () => {
  // Resetting only on session_start made three early judgements permanent: a
  // later task could not be routed at all.
  const mutable = { difficulty: 2.2 };
  const h = harness({
    askImpl: async () => ({
      answers: { difficulty: { type: "score", score: mutable.difficulty } },
    }),
  });
  const calls = () => h.askCount();

  await h.run("start the first task on the parser rewrite in this repository");
  mutable.difficulty = 0.5;
  h.say("start the first task on the parser rewrite in this repository", { failures: 3 });
  await h.run("keep going");
  h.say("keep going", { failures: 3 });
  await h.run("keep going");
  assert.equal(calls(), 3, "three attempts spent inside one task");

  // A new task must judge again rather than inherit the exhausted budget.
  mutable.difficulty = 2.4;
  await h.run("now audit the deployment scripts for security problems end to end");
  assert.equal(calls(), 4, "new task gets a fresh budget");
});

test("a failed judgement is counted, cooldown-limited, and never permanent", async () => {
  let attempts = 0;
  const h = harness({
    askImpl: async () => {
      attempts++;
      throw new Error("judge down");
    },
  });
  await h.run("audit the routing design and tell me what is wrong with it");
  assert.equal(attempts, 1);
  h.say("audit the routing design and tell me what is wrong with it");
  await h.run("keep going");
  await h.run("keep going");
  assert.equal(attempts, 1, "a dead judge is not retried every turn");
});

test("a stuck turn cannot step the model down mid-task", async () => {
  const mutable = { difficulty: 2.2 };
  const h = harness({
    askImpl: async () => ({
      answers: { difficulty: { type: "score", score: mutable.difficulty } },
    }),
  });
  await h.run("start the refactor of the routing extension in this repository");
  assert.equal(h.setModelCalls.length, 1, "escalated");
  h.say("start the refactor of the routing extension in this repository", { failures: 2 });

  mutable.difficulty = 0.2;
  await h.run("keep going");
  assert.equal(h.setModelCalls.length, 1, "still escalated: this is the same failing task");

  await h.run("now explain the deploy pipeline end to end for a new reader");
  assert.equal(h.setModelCalls.length, 2, "a real new task steps back down");
  assert.equal(h.setModelCalls[1], LUNA);
});

test("a model the user picks by hand ends the router's ownership", async () => {
  const other = { provider: "openrouter", id: "x-ai/other" };
  const mutable = { difficulty: 2.2 };
  const h = harness({
    askImpl: async () => ({
      answers: { difficulty: { type: "score", score: mutable.difficulty } },
    }),
  });
  await h.run("start the refactor of the routing extension in this repository");
  assert.equal(h.setModelCalls.length, 1);

  h.selectModel(other);
  mutable.difficulty = 0.2;
  h.say("start the refactor of the routing extension in this repository");
  await h.run("now explain the deploy pipeline end to end for a new reader");
  assert.equal(
    h.setModelCalls.length,
    1,
    "the router does not override or restore over a manual choice",
  );
});

test("a decision that arrives after /route off switches nothing", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = harness({
    askImpl: async () => {
      await gate;
      return { answers: { difficulty: { type: "score", score: 2.6 } } };
    },
  });
  const pending = h.run("audit the routing design and tell me what is wrong with it");
  await h.command("off");
  release();
  await pending;
  assert.equal(h.setModelCalls.length, 0, "a stale judgement must not switch models");
});

test("a subagent child is identified at load time, not per prompt", async () => {
  // pi-subagents clears the flag before the child first prompts, so a runtime
  // check never sees it and children get routed.
  process.env.PI_SUBAGENT_CHILD = "1";
  const h = harness({ difficulty: 2.6 });
  delete process.env.PI_SUBAGENT_CHILD;
  await h.run("audit the routing design");
  assert.equal(h.askCount(), 0);
});
