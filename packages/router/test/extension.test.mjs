// End-to-end tests for the router entry: a fake pi, a fake model registry and a
// canned judgement drive the real virtual model's route(). No network.
//
// The behaviours worth pinning are the ones the measurements argued for: hold
// the decision while a task continues, escalate only above the threshold, come
// back down only at a new task, and never treat a missing judgement as a reason
// to spend less.

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import piRouterExtension from "../index.ts";
import { DIFFICULTY_THRESHOLD } from "../model-battery.mjs";
import { SHORT_USAGE_COOLDOWN_MS } from "../usage-cap.mjs";

const LUNA = { provider: "openai-codex", id: "gpt-5.6-luna" };
const DEEPSEEK = { provider: "deepseek", id: "deepseek-flash", contextWindow: 1000000 };
// The Codex frontier models hold 272K while the deepseek base holds 1M, which is
// the collision the context guard exists for.
const ASTRA = { provider: "openai-codex", id: "gpt-6-astra", contextWindow: 272000 };
const SOL = { provider: "openai-codex", id: "gpt-5.6-sol", contextWindow: 272000 };

const ENV = {
  PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD,
  PI_ROUTER: process.env.PI_ROUTER,
};

// Every router.json a harness writes, so the temp files are cleaned up.
const tempDirs = [];

/** A config file for one harness. `config` is an object, raw text, or absent. */
function tempConfig(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "router-test-"));
  tempDirs.push(dir);
  const file = path.join(dir, "router.json");
  if (typeof config === "string") fs.writeFileSync(file, config);
  else if (config !== undefined) fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  return file;
}

beforeEach(() => {
  for (const key of Object.keys(ENV)) delete process.env[key];
});

after(() => {
  for (const [key, value] of Object.entries(ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

// The wire shapes pi hands route(); helpers keep the tests about routing.
const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text = "done", usage) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  ...(usage ? { usage } : {}),
});
const failed = () => ({ role: "toolResult", toolName: "bash", isError: true });
/** One completed turn: the prompt, a reply, and any failed tool calls. */
const turn = (prompt, { reply = "done", usage, failures = 0 } = {}) => {
  const messages = [user(prompt), assistant(reply, usage)];
  for (let i = 0; i < failures; i++) messages.push(failed());
  return messages;
};

function harness({
  difficulty = 0.7,
  available = [LUNA, ASTRA, SOL],
  scopedModels,
  thinkingLevel = "medium",
  askImpl,
  config,
  now,
  branch = [],
  routerSelected = false,
} = {}) {
  const commands = {};
  const handlers = {};
  const notifications = [];
  const statuses = [];
  const entries = [];
  const askArgs = [];
  const configPath = tempConfig(config);
  let virtualModel = null;

  const pi = {
    on: (event, handler) => {
      handlers[event] = handler;
    },
    registerCommand: (name, def) => {
      commands[name] = def;
    },
    appendEntry: (customType, data) => entries.push({ customType, data }),
    registerVirtualModel: (def) => {
      virtualModel = def;
    },
  };

  const ctx = {
    cwd: "/Users/mattriley/repo",
    hasUI: true,
    get model() {
      return routerSelected ? { provider: "router", id: "auto" } : null;
    },
    thinkingLevel,
    scopedModels,
    modelRegistry: {
      getAvailable: () => available,
      find: (provider, id) =>
        available.find((model) => model.provider === provider && model.id === id) ?? null,
      getModel: (provider, id) =>
        available.find((model) => model.provider === provider && model.id === id) ?? null,
    },
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
      askArgs.push(args[0]);
      return judge(...args);
    },
    configPath,
    now,
  });

  return {
    configPath,
    notifications,
    statuses,
    entries,
    askCount: () => askArgs.length,
    askArgs,
    definitions: () => virtualModel,
    run: (prompt, { state, reason = "user", previous, failed: failedRoute, messages } = {}) =>
      virtualModel.route(
        {
          reason,
          state,
          previous,
          failed: failedRoute,
          thinkingLevel,
          messages: messages ?? [user(prompt)],
        },
        ctx,
      ),
    command: (args) => commands.route.handler(args, ctx),
    emit: (event, payload) => handlers[event]?.(payload, ctx),
    input: async (text, source = "interactive") => handlers.input?.({ text, source }, ctx),
  };
}

// ---------------------------------------------------------------------------
// Escalation and holding

test("escalates to the frontier model when the task rates hard", async () => {
  const h = harness({ difficulty: 2.6 });
  const routed = await h.run("audit the routing design and tell me what is wrong with it");
  assert.equal(routed.model, ASTRA, "first pattern wins");
  assert.equal(routed.thinkingLevel, "medium");
  assert.equal(routed.state.tier, "frontier");
  assert.match(h.notifications.at(-1).title, /difficulty 2\.60/);
});

test("holds the base model when the task rates easy", async () => {
  const h = harness({ difficulty: 0.6 });
  const routed = await h.run("what does this function do");
  assert.equal(routed.model, LUNA);
  assert.equal(routed.state.tier, "base");
});

test("an economy base escalates to the mid tier before the frontier", async () => {
  const h = harness({
    difficulty: 1.8,
    available: [DEEPSEEK, LUNA, ASTRA, SOL],
    config: { base: "deepseek/deepseek-flash" },
  });
  const routed = await h.run("fix the failing parser tests in the guardrail package");
  assert.equal(routed.model, ASTRA, "the mid pattern, not the frontier");
  assert.equal(routed.thinkingLevel, "low");
});

test("a mid-rated task escalates to the mid tier pair", async () => {
  const h = harness({ difficulty: 1.8 });
  const routed = await h.run("fix the failing parser tests in the guardrail package");
  assert.equal(routed.model, ASTRA);
  assert.equal(routed.thinkingLevel, "low");
  const entry = h.entries.find((e) => e.customType === "router-decision");
  assert.equal(entry.data.outcome, "escalated");
  assert.equal(entry.data.to, "openai-codex/gpt-6-astra");
});

test("a selected thinking cap above the mid pair is not lowered on the same model", async () => {
  const h = harness({
    difficulty: 1.8,
    thinkingLevel: "max",
    config: { mid: [{ model: "openai-codex/gpt-5.6-luna", thinking: "xhigh" }] },
  });
  const routed = await h.run("fix the failing parser tests in the guardrail package");
  assert.equal(routed.model, LUNA);
  assert.equal(routed.thinkingLevel, "xhigh");
});

test("a frontier cap selects Sol xhigh instead of Astra low", async () => {
  const h = harness({
    difficulty: 2.6,
    available: [DEEPSEEK, LUNA, ASTRA, SOL],
    thinkingLevel: "xhigh",
    // The string form is accepted as a one-entry list.
    config: { base: "deepseek/deepseek-flash" },
  });
  const routed = await h.run("audit the routing design and tell me what is wrong with it");
  assert.equal(routed.model, SOL);
  assert.equal(routed.thinkingLevel, "xhigh");
  const entry = h.entries.find((e) => e.customType === "router-decision");
  assert.equal(entry.data.outcome, "escalated");
  assert.equal(entry.data.to, "openai-codex/gpt-5.6-sol");
});

test("a low cap filters Sol pairs and selects Astra low", async () => {
  const h = harness({ difficulty: 2.6, thinkingLevel: "low" });
  const routed = await h.run("audit the routing design and tell me what is wrong with it");
  assert.equal(routed.model, ASTRA);
  assert.equal(routed.thinkingLevel, "low");
});

test("a max cap selects the strongest Sol pair", async () => {
  const h = harness({ difficulty: 2.6, thinkingLevel: "max" });
  const routed = await h.run("audit the routing design and tell me what is wrong with it");
  assert.equal(routed.model, SOL);
  assert.equal(routed.thinkingLevel, "max");
});

test("a base already above the target tier holds, with its thinking", async () => {
  const h = harness({
    difficulty: 1.8,
    thinkingLevel: "max",
    config: { base: "openai-codex/gpt-6-astra" },
  });
  const routed = await h.run("fix the failing parser tests in the guardrail package");
  assert.equal(routed.model, ASTRA);
  assert.equal(routed.thinkingLevel, "max");
});

test("a frontier base is never pulled down to a mid target", async () => {
  const h = harness({
    difficulty: 1.8,
    available: [ASTRA, SOL, LUNA],
    config: { base: "openai-codex/gpt-6-astra" },
  });
  const routed = await h.run("fix the failing parser tests in the guardrail package");
  assert.equal(routed.model, ASTRA);
});

test("a model already at the target tier is not re-picked", async () => {
  // SOL is frontier already; ASTRA ranks first in the frontier list, but the
  // target tier does not outrank the current one, so nothing switches.
  const h = harness({ difficulty: 2.6, config: { base: "openai-codex/gpt-5.6-sol" } });
  const routed = await h.run("audit the routing design and tell me what is wrong with it");
  assert.equal(routed.model, SOL, "a rank-equal target must not switch");
});

test("a router-chosen frontier model holds through a mid-rated new task", async () => {
  const mutable = { difficulty: 2.6 };
  const h = harness({
    askImpl: async () => ({
      answers: { difficulty: { type: "score", score: mutable.difficulty } },
    }),
  });

  const first = await h.run("audit the routing design and tell me what is wrong with it");
  assert.equal(first.model, ASTRA);

  mutable.difficulty = 1.8;
  const next = await h.run("now rewrite the deploy pipeline notes for a brand new reader", {
    state: first.state,
    messages: [
      ...turn("audit the routing design and tell me what is wrong with it"),
      user("now rewrite the deploy pipeline notes for a brand new reader"),
    ],
  });
  assert.equal(next.model, ASTRA, "holds frontier rather than stepping down to mid");
});

// ---------------------------------------------------------------------------
// Coming back down

test("steps back down to the base at a new task", async () => {
  const mutable = { difficulty: 2.6 };
  const h = harness({
    askImpl: async () => ({
      answers: { difficulty: { type: "score", score: mutable.difficulty } },
    }),
  });

  const first = await h.run("audit the routing design and tell me what is wrong with it");
  assert.equal(first.model, ASTRA);

  mutable.difficulty = 0.4;
  const next = await h.run(
    "now explain how the deploy pipeline works end to end for a new reader",
    {
      state: first.state,
      messages: [
        ...turn("audit the routing design and tell me what is wrong with it"),
        user("now explain how the deploy pipeline works end to end for a new reader"),
      ],
    },
  );
  assert.equal(next.model, LUNA);
  assert.equal(next.thinkingLevel, "medium");
  assert.match(h.notifications.at(-1).title, /back to openai-codex\/gpt-5\.6-luna/);
  assert.equal(h.entries.at(-1).data.outcome, "stepped-down");
});

test("a stuck turn cannot step the model down mid-task", async () => {
  const mutable = { difficulty: 2.6 };
  const h = harness({
    askImpl: async () => ({
      answers: { difficulty: { type: "score", score: mutable.difficulty } },
    }),
  });

  const first = await h.run("start the refactor of the routing extension in this repository");
  assert.equal(first.model, ASTRA, "escalated");

  mutable.difficulty = 0.2;
  const stuck = await h.run("keep going", {
    state: first.state,
    messages: [
      ...turn("start the refactor of the routing extension in this repository", { failures: 2 }),
      user("keep going"),
    ],
  });
  assert.equal(stuck.model, ASTRA, "still escalated: this is the same failing task");

  const newTask =
    "now explain how the deploy pipeline works end to end for a new reader, including every stage from merge to production, who owns each step, what can fail silently, what we should monitor, and how rollbacks work";
  const next = await h.run(newTask, {
    state: stuck.state,
    messages: [...turn("keep going", { failures: 2 }), user(newTask)],
  });
  assert.equal(next.model, LUNA, "a real new task steps back down");
});

test("a frustrated low-overlap follow-up after two failures does not step down or reset the budget", async () => {
  const mutable = { difficulty: 2.6 };
  const h = harness({
    askImpl: async () => ({
      answers: { difficulty: { type: "score", score: mutable.difficulty } },
    }),
  });

  const taskPrompt = "fix the flaky CI on subagent spawn test, investigate the race";
  const first = await h.run(taskPrompt);
  assert.equal(first.model, ASTRA, "escalated");

  mutable.difficulty = 0.2;
  const frustrated = "still failing. third time. find the actual race";
  const stuck = await h.run(frustrated, {
    state: first.state,
    messages: [...turn(taskPrompt, { failures: 2 }), user(frustrated)],
  });
  assert.equal(stuck.model, ASTRA, "must not step down on a stuck continuation");
  assert.equal(h.askCount(), 2, "re-judged the stuck turn without resetting the task budget");

  mutable.difficulty = 0.2;
  const afterOneFailure = await h.run(frustrated, {
    state: first.state,
    messages: [...turn(taskPrompt, { failures: 1 }), user(frustrated)],
  });
  assert.equal(afterOneFailure.model, LUNA, "one failure still allows a topic-shift step-down");
});

// ---------------------------------------------------------------------------
// Holding, retries and direct requests

test("a continuation is not re-judged and holds the decision", async () => {
  const h = harness({ difficulty: 2.6 });
  const first = await h.run("audit the routing design and tell me what is wrong with it");
  const continued = await h.run("", {
    reason: "continuation",
    state: first.state,
    previous: { provider: ASTRA.provider, id: ASTRA.id, thinkingLevel: "medium" },
    messages: [
      ...turn("audit the routing design and tell me what is wrong with it"),
      assistant("working", { input: 100, cacheRead: 0 }),
    ],
  });
  assert.equal(h.askCount(), 1, "one judgement for the task, not one per request");
  assert.equal(continued.model, ASTRA);
});

test("a retry stays on the model that failed", async () => {
  const h = harness({ difficulty: 2.6 });
  const first = await h.run("audit the routing design and tell me what is wrong with it");
  const retried = await h.run("", {
    reason: "retry",
    state: first.state,
    failed: { provider: ASTRA.provider, id: ASTRA.id, thinkingLevel: "medium" },
    messages: [user("audit the routing design and tell me what is wrong with it")],
  });
  assert.equal(retried.model, ASTRA);
  assert.equal(h.askCount(), 1);
});

test("a direct request goes to the base without a judgement", async () => {
  const h = harness({ difficulty: 2.6 });
  const routed = await h.run("", { reason: "direct", messages: [] });
  assert.equal(routed.model, LUNA);
  assert.equal(h.askCount(), 0);
  assert.equal(routed.state, undefined);
});

test("a task that is failing gets re-judged", async () => {
  const h = harness({ difficulty: 2.6 });
  const first = await h.run("fix the failing parser tests in the guardrail package");
  await h.run("keep going", {
    state: first.state,
    messages: [
      ...turn("fix the failing parser tests in the guardrail package", { failures: 2 }),
      user("keep going"),
    ],
  });
  assert.equal(h.askCount(), 2);
});

test("the judgement budget resets at a task boundary", async () => {
  // Resetting only per session made three early judgements permanent: a later
  // task could not be routed at all.
  const mutable = { difficulty: 2.2 };
  const h = harness({
    askImpl: async () => ({
      answers: { difficulty: { type: "score", score: mutable.difficulty } },
    }),
  });

  const convo = [];
  let routed = await h.run("start the first task on the parser rewrite in this repository");
  convo.push(
    ...turn("start the first task on the parser rewrite in this repository", { failures: 3 }),
  );

  for (const prompt of ["keep going", "keep going"]) {
    routed = await h.run(prompt, {
      state: routed.state,
      messages: [...convo, user(prompt)],
    });
    convo.push(...turn(prompt, { failures: 3 }));
  }
  assert.equal(h.askCount(), 3, "three attempts spent inside one task");

  // A new task must judge again rather than inherit the exhausted budget.
  const prompt =
    "now audit the deployment scripts for security problems end to end, including secrets handling, least privilege on every credential, network exposure, and what an attacker could reach from a compromised runner";
  await h.run(prompt, { state: routed.state, messages: [...convo, user(prompt)] });
  assert.equal(h.askCount(), 4, "new task gets a fresh budget");
});

test("a failed judgement is counted, cooldown-limited, and never permanent", async () => {
  const h = harness({
    askImpl: async () => {
      throw new Error("judge down");
    },
  });

  const convo = [];
  let routed = await h.run("start the first task on the parser rewrite in this repository");
  assert.equal(h.askCount(), 1);
  assert.equal(routed.state.cooldown, 3);
  convo.push(...turn("start the first task on the parser rewrite in this repository"));

  for (const prompt of [
    "explain the deployment pipeline to a new reader please",
    "summarise the authentication design decisions",
    "describe how the extension loader resolves packages",
  ]) {
    routed = await h.run(prompt, { state: routed.state, messages: [...convo, user(prompt)] });
    convo.push(...turn(prompt));
  }
  assert.equal(h.askCount(), 2, "the judge is retried after the cooldown, not every turn");
});

// ---------------------------------------------------------------------------
// Failure modes keep the model that was working

test("a failed judgement keeps the model that was working", async () => {
  const h = harness({
    askImpl: async () => {
      throw new Error("TYPESAFE_API_KEY is not set");
    },
  });
  const routed = await h.run("audit the routing design");
  assert.equal(routed.model, LUNA);
  assert.equal(
    h.entries.find((e) => e.customType === "router-decision").data.outcome,
    "judge-failed",
  );
});

test("an unusable rating is not a decision to spend less", async () => {
  const h = harness({
    askImpl: async () => ({ answers: { difficulty: { type: "score", score: null } } }),
  });
  const routed = await h.run("audit the routing design");
  assert.equal(routed.model, LUNA);
  assert.equal(h.entries.at(-1).data.outcome, "no-rating");
});

test("no available frontier model says so instead of guessing", async () => {
  const h = harness({ difficulty: 2.6, available: [LUNA] });
  const routed = await h.run("audit the routing design");
  assert.equal(routed.model, LUNA);
  assert.match(h.notifications.at(-1).title, /no frontier model is available/);
});

test("a missing mid model says so, not 'frontier'", async () => {
  const h = harness({
    difficulty: 1.8,
    available: [DEEPSEEK, ASTRA, SOL],
    config: {
      base: "deepseek/deepseek-flash",
      mid: [{ model: "openai-codex/gpt-5.6-luna", thinking: "xhigh" }],
    },
  });
  const routed = await h.run("fix the failing parser tests in the guardrail package");
  assert.equal(routed.model, DEEPSEEK);
  assert.match(h.notifications.at(-1).title, /no mid model is available/);
  assert.equal(h.entries.at(-1).data.outcome, "no-mid-model");
});

test("a held model that disappeared falls back to the base", async () => {
  const h = harness({ difficulty: 0.6, available: [LUNA] });
  const routed = await h.run("what does this function do", {
    state: {
      task: 1,
      attempts: 1,
      cooldown: 0,
      tier: "frontier",
      model: "openai-codex/gpt-6-astra",
      thinking: "medium",
      base: null,
    },
  });
  assert.equal(routed.model, LUNA);
});

test("no physical model at all fails loudly instead of sending the virtual one", async () => {
  const h = harness({ available: [] });
  await assert.rejects(() => h.run("audit the routing design"), /no physical model/);
});

test("a base pattern that matches nothing falls back to the last physical model", async () => {
  const h = harness({
    difficulty: 0.6,
    available: [DEEPSEEK],
    config: { base: "nowhere/nothing" },
  });
  const routed = await h.run("what does this function do", {
    previous: { provider: DEEPSEEK.provider, id: DEEPSEEK.id },
  });
  assert.equal(routed.model, DEEPSEEK);
});

// ---------------------------------------------------------------------------
// Scope and capacity

test("a scoped session is never escaped", async () => {
  // The user pinned this session to one model; routing must stay inside it.
  const h = harness({ difficulty: 2.6, scopedModels: [{ model: LUNA }], available: [LUNA, ASTRA] });
  const routed = await h.run("audit the routing design");
  assert.equal(routed.model, LUNA, "astra is available but not scoped into this session");
});

test("refuses to escalate into a window the session would not fit", async () => {
  // Context read 452k on the p90 turn here; gpt-6-astra holds 272k. Switching
  // would compact the session, which is the opposite of what escalation is for.
  const h = harness({
    difficulty: 2.6,
    available: [DEEPSEEK, LUNA, ASTRA, SOL],
    config: { base: "deepseek/deepseek-flash" },
  });
  const history = turn("start on the big refactor task in this repository please", {
    reply: "Working through it.",
    usage: { input: 2000, cacheRead: 450000 },
  });
  const routed = await h.run("and now finish the analysis of the whole thing for me", {
    messages: [...history, user("and now finish the analysis of the whole thing for me")],
  });
  assert.equal(routed.model, DEEPSEEK);
  assert.match(
    h.notifications.at(-1).title,
    /reads 452k tokens and no available frontier model fits it/,
  );
});

test("the capacity filter reads the window inside a scoped {model} wrapper", async () => {
  // ctx.scopedModels hands out wrappers; reading the window off the wrapper saw
  // undefined, treated the scoped model as unbounded, and let this escalate
  // into a 272k window at 452k of context.
  const h = harness({
    difficulty: 2.6,
    scopedModels: [{ model: DEEPSEEK }, { model: ASTRA, thinkingLevel: "high" }],
    available: [DEEPSEEK, ASTRA],
    config: { base: "deepseek/deepseek-flash" },
  });
  const history = turn("start on the big refactor task in this repository please", {
    reply: "Working through it.",
    usage: { input: 2000, cacheRead: 450000 },
  });
  const routed = await h.run("and now finish the analysis of the whole thing for me", {
    messages: [...history, user("and now finish the analysis of the whole thing for me")],
  });
  assert.equal(routed.model, DEEPSEEK);
  assert.match(h.notifications.at(-1).title, /no available frontier model fits it/);
});

test("escalates when the session still fits the frontier window", async () => {
  const h = harness({
    difficulty: 2.6,
    available: [DEEPSEEK, LUNA, ASTRA, SOL],
    config: { base: "deepseek/deepseek-flash" },
  });
  const history = turn("start on the big refactor task in this repository please", {
    reply: "Working through it.",
    usage: { input: 2000, cacheRead: 100000 },
  });
  const routed = await h.run("and now finish the analysis of the whole thing for me", {
    messages: [...history, user("and now finish the analysis of the whole thing for me")],
  });
  assert.equal(routed.model, ASTRA);
});

// ---------------------------------------------------------------------------
// The model lists live in router.json

test("the config file is created with the built-in lists", async () => {
  const h = harness({ difficulty: 0.6 });
  const created = JSON.parse(fs.readFileSync(h.configPath, "utf8"));
  assert.deepEqual(created.base, [
    { model: "openai-codex/gpt-5.6-luna", thinking: "medium" },
    { model: "openai-codex/gpt-5.6-luna" },
  ]);
  assert.deepEqual(created.mid, [
    { model: "openai-codex/gpt-6-astra", thinking: "low" },
    { model: "openai-codex/gpt-5.6-luna", thinking: "xhigh" },
  ]);
  assert.ok(
    created.frontier.some(
      (entry) => entry.model === "openai-codex/gpt-6-astra" && entry.thinking === "low",
    ),
  );
});

test("editing the config takes effect at the next task", async () => {
  const h = harness({ difficulty: 0.6, available: [DEEPSEEK, LUNA, ASTRA, SOL] });
  const first = await h.run("what does this function do");
  assert.equal(first.model, LUNA);

  fs.writeFileSync(h.configPath, `${JSON.stringify({ base: "deepseek/deepseek-flash" })}\n`);
  const prompt = "now explain the deploy pipeline end to end for a new reader";
  const next = await h.run(prompt, {
    state: first.state,
    messages: [...turn("what does this function do"), user(prompt)],
  });
  assert.equal(next.model, DEEPSEEK);
  assert.equal(next.state.base, "deepseek/deepseek-flash");
});

test("an empty tier list is a decision, not a typo", async () => {
  const h = harness({ difficulty: 2.6, config: { frontier: [] } });
  const routed = await h.run("audit the routing design");
  assert.equal(routed.model, LUNA);
  assert.equal(h.entries.at(-1).data.outcome, "no-frontier-model");
});

test("a broken config falls back to the defaults and says so once", async () => {
  const h = harness({ difficulty: 0.6, config: "{ not json" });
  const first = await h.run("what does this function do");
  assert.equal(first.model, LUNA);
  assert.match(h.notifications.at(-1).title, /not valid JSON/);

  const prompt = "now explain the deploy pipeline end to end for a new reader";
  await h.run(prompt, {
    state: first.state,
    messages: [...turn("what does this function do"), user(prompt)],
  });
  assert.equal(
    h.notifications.filter((entry) => /not valid JSON/.test(entry.title)).length,
    1,
    "one warning per session, not one per judgement",
  );
});

test("/route status names the config file and its lists", async () => {
  const h = harness({ difficulty: 0.6, config: { frontier: ["grok-4.6"] } });
  await h.command("status");
  const status = h.notifications.at(-1).title;
  const escaped = h.configPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(status, new RegExp(escaped));
  assert.match(status, /frontier grok-4\.6/);
});

// ---------------------------------------------------------------------------
// Telemetry, status and the escape hatches

test("every judgement is recorded as a non-context entry", async () => {
  // The report joins these to what happened later: a held decision followed by
  // a manual escalation is a miss, an escalation followed by a retreat is not.
  const h = harness({ difficulty: 2.6 });
  await h.run("audit the routing design and tell me what is wrong with it");
  const entry = h.entries.find((e) => e.customType === "router-decision");
  assert.ok(entry, JSON.stringify(h.entries));
  assert.equal(entry.data.outcome, "escalated");
  assert.equal(entry.data.tier, "frontier");
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
  assert.equal(entry.data.tier, null);
  assert.equal(entry.data.threshold, 1.5);
});

test("the footer status says what the router is doing", async () => {
  const h = harness({ difficulty: 2.6 });
  await h.run("audit the routing design and tell me what is wrong with it");
  assert.ok(
    h.statuses.some((entry) => /^router: gpt-6-astra@medium · 2\.6$/.test(entry.text)),
    JSON.stringify(h.statuses),
  );
});

test("state from a previous version is ignored rather than trusted", async () => {
  const h = harness({ difficulty: 0.6 });
  const routed = await h.run("what does this function do", { state: { nonsense: true } });
  assert.equal(routed.model, LUNA);
  assert.equal(h.askCount(), 1);
  assert.equal(routed.state.task, 1);
});

test("/route off disarms it, /route on re-arms it", async () => {
  const h = harness({ difficulty: 2.6 });
  await h.command("off");
  const off = await h.run("audit the routing design");
  assert.equal(h.askCount(), 0);
  assert.equal(off.model, LUNA);
  await h.command("on");
  const on = await h.run("audit the routing design again properly");
  assert.equal(h.askCount(), 1);
  assert.equal(on.model, ASTRA);
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
  const routed = await pending;
  assert.equal(routed.model, LUNA, "a stale judgement must not switch models");
});

test("/route status reports what it has been doing", async () => {
  const h = harness({ difficulty: 2.6 });
  await h.run("audit the routing design");
  await h.command("status");
  const status = h.notifications.at(-1).title;
  assert.match(status, /Router on/);
  assert.match(status, /1 judged/);
  assert.match(status, /1 escalated/);
  assert.match(status, new RegExp(`threshold ${DIFFICULTY_THRESHOLD}`));
  assert.match(status, /mid .*gpt-6-astra@low/);
  assert.match(status, /frontier .*gpt-5\.6-sol@max/);
  assert.match(status, /routed to openai-codex\/gpt-6-astra/);
});

test("a subagent child holds the base without judging", async () => {
  process.env.PI_SUBAGENT_CHILD = "1";
  const h = harness({ difficulty: 2.6 });
  delete process.env.PI_SUBAGENT_CHILD;
  const routed = await h.run("audit the routing design");
  assert.equal(h.askCount(), 0, "the flag is captured at load time, not per request");
  assert.equal(routed.model, LUNA);
});

test("a subagent child with a pinned physical model keeps it and its thinking", async () => {
  process.env.PI_SUBAGENT_CHILD = "1";
  const h = harness({ difficulty: 2.6, thinkingLevel: "high" });
  delete process.env.PI_SUBAGENT_CHILD;
  const routed = await h.run("review the diff", {
    previous: { model: SOL, thinkingLevel: "high" },
  });
  assert.equal(h.askCount(), 0);
  assert.equal(routed.model, SOL);
  assert.equal(routed.thinkingLevel, "high");
});

test("an inheriting subagent child keeps base model but not base-tier thinking", async () => {
  process.env.PI_SUBAGENT_CHILD = "1";
  const h = harness({
    difficulty: 2.6,
    thinkingLevel: "high",
    config: { base: [{ model: "openai-codex/gpt-5.6-luna", thinking: "medium" }] },
  });
  delete process.env.PI_SUBAGENT_CHILD;
  const routed = await h.run("scout the repo");
  assert.equal(routed.model, LUNA);
  assert.equal(routed.thinkingLevel, "high");
});

test("PI_ROUTER=off disarms it before the first turn", async () => {
  process.env.PI_ROUTER = "off";
  const h = harness({ difficulty: 2.6 });
  const routed = await h.run("audit the routing design");
  assert.equal(h.askCount(), 0);
  assert.equal(routed.model, LUNA);
});

const WS_USAGE_LEAK =
  'Codex error: {"type":"error","status":429,"error":{"type":"usage_limit_reached","message":"The usage limit has been reached"}}';

test("a websocket usage-limit leak on retry fails over within the tier", async () => {
  const h = harness({
    difficulty: 2.6,
    config: {
      frontier: [
        { model: "openai-codex/gpt-6-astra", thinking: "medium" },
        { model: "openai-codex/gpt-5.6-sol", thinking: "medium" },
      ],
    },
  });
  const first = await h.run("audit the routing design and tell me what is wrong with it");
  assert.equal(first.model, ASTRA);
  const retried = await h.run("", {
    reason: "retry",
    state: first.state,
    failed: {
      provider: ASTRA.provider,
      id: ASTRA.id,
      thinkingLevel: "medium",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: WS_USAGE_LEAK,
        provider: ASTRA.provider,
        model: ASTRA.id,
      },
    },
  });
  assert.equal(retried.model, SOL);
  const failover = h.entries.find((entry) => entry.data?.outcome === "failover");
  assert.ok(failover, JSON.stringify(h.entries.map((entry) => entry.data?.outcome)));
  assert.equal(failover.data.to, "openai-codex/gpt-5.6-sol");
  assert.equal(failover.data.from, "openai-codex/gpt-6-astra");
});

test("an SSE usage limit with a reset suffix cools that model for the next turn", async () => {
  const h = harness({
    difficulty: 2.6,
    config: {
      frontier: [
        { model: "openai-codex/gpt-6-astra", thinking: "medium" },
        { model: "openai-codex/gpt-5.6-sol", thinking: "medium" },
      ],
    },
  });
  const first = await h.run("audit the routing design and tell me what is wrong with it");
  assert.equal(first.model, ASTRA);
  await h.emit("agent_end", {
    messages: [
      ...turn("audit the routing design and tell me what is wrong with it"),
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "You have hit your ChatGPT usage limit (plus plan). Try again in ~180 min.",
        provider: "openai-codex",
        model: "gpt-6-astra",
      },
    ],
  });
  const prompt = "now explain the deploy pipeline end to end for a new reader";
  const next = await h.run(prompt, {
    state: first.state,
    messages: [...turn("audit the routing design and tell me what is wrong with it"), user(prompt)],
  });
  assert.equal(next.model, SOL);
});

test("a usage-limit retry warns instead of throwing when the whole tier is cooling", async () => {
  const h = harness({
    difficulty: 2.6,
    available: [LUNA, ASTRA],
    config: { frontier: [{ model: "openai-codex/gpt-6-astra", thinking: "medium" }] },
  });
  const first = await h.run("audit the routing design and tell me what is wrong with it");
  assert.equal(first.model, ASTRA);
  const retried = await h.run("", {
    reason: "retry",
    state: first.state,
    failed: {
      provider: ASTRA.provider,
      id: ASTRA.id,
      thinkingLevel: "medium",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: WS_USAGE_LEAK,
        provider: ASTRA.provider,
        model: ASTRA.id,
      },
    },
  });
  assert.equal(retried.model, ASTRA);
  assert.match(h.notifications.at(-1).title, /cooling down/);
});

test("turn_end records a usage cap the same way the end of a turn does", async () => {
  const h = harness({
    difficulty: 2.6,
    config: {
      frontier: [
        { model: "openai-codex/gpt-6-astra", thinking: "medium" },
        { model: "openai-codex/gpt-5.6-sol", thinking: "medium" },
      ],
    },
  });
  const first = await h.run("audit the routing design and tell me what is wrong with it");
  await h.emit("turn_end", {
    messages: [
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "You have hit your ChatGPT usage limit (plus plan). Try again in ~180 min.",
        provider: "openai-codex",
        model: "gpt-6-astra",
      },
    ],
  });
  const prompt = "now explain the deploy pipeline end to end for a new reader";
  const next = await h.run(prompt, {
    state: first.state,
    messages: [...turn("audit the routing design and tell me what is wrong with it"), user(prompt)],
  });
  assert.equal(next.model, SOL);
});

const TWO_FRONTIER = {
  frontier: [
    { model: "openai-codex/gpt-6-astra", thinking: "medium" },
    { model: "openai-codex/gpt-5.6-sol", thinking: "medium" },
  ],
};

const usageError = (text, model) => ({
  role: "assistant",
  stopReason: "error",
  errorMessage: text,
  provider: "openai-codex",
  model,
});

test("an SSE usage limit without a suffix expires after the short default", async () => {
  let now = 1_700_000_000_000;
  const h = harness({ difficulty: 2.6, now: () => now, config: TWO_FRONTIER });
  const first = await h.run("audit the routing design and tell me what is wrong with it");
  await h.emit("agent_end", {
    messages: [usageError("You have hit your ChatGPT usage limit.", ASTRA.id)],
  });
  const cooledPrompt = "explain the deploy pipeline end to end for a new reader";
  const cooled = await h.run(cooledPrompt, {
    state: first.state,
    messages: [
      ...turn("audit the routing design and tell me what is wrong with it"),
      user(cooledPrompt),
    ],
  });
  assert.equal(cooled.model, SOL);
  now += SHORT_USAGE_COOLDOWN_MS - 1;
  const stillPrompt = "inventory every on-call contact in the pager directory";
  const still = await h.run(stillPrompt, {
    state: cooled.state,
    messages: [...turn(cooledPrompt), user(stillPrompt)],
  });
  assert.equal(still.model, SOL);
  now += 1;
  const backPrompt = "rewrite the release checklist for the mobile client";
  const back = await h.run(backPrompt, {
    state: still.state,
    messages: [...turn(stillPrompt), user(backPrompt)],
  });
  assert.equal(back.model, ASTRA);
});

test("when every pair in a tier is cooling the next turn warns and stays", async () => {
  const h = harness({ difficulty: 2.6, config: TWO_FRONTIER });
  const first = await h.run("audit the routing design and tell me what is wrong with it");
  await h.emit("agent_end", {
    messages: [
      usageError("You have hit your ChatGPT usage limit. Try again in ~30 min.", ASTRA.id),
    ],
  });
  await h.emit("agent_end", {
    messages: [usageError("You have hit your ChatGPT usage limit. Try again in ~30 min.", SOL.id)],
  });
  const prompt = "explain the deploy pipeline end to end for a new reader";
  const stayed = await h.run(prompt, {
    state: first.state,
    messages: [...turn("audit the routing design and tell me what is wrong with it"), user(prompt)],
  });
  assert.equal(stayed.model, ASTRA);
  assert.match(h.notifications.at(-1).title, /cooling down/);
});

test("an overload retry stays on the model that failed", async () => {
  const h = harness({ difficulty: 2.6, config: TWO_FRONTIER });
  const first = await h.run("audit the routing design and tell me what is wrong with it");
  const retried = await h.run("", {
    reason: "retry",
    state: first.state,
    failed: {
      provider: ASTRA.provider,
      id: ASTRA.id,
      thinkingLevel: "medium",
      message: usageError(
        "Our servers are currently overloaded. Please try again later.",
        ASTRA.id,
      ),
    },
  });
  assert.equal(retried.model, ASTRA);
  assert.equal(
    h.entries.some((entry) => entry.data?.outcome === "failover"),
    false,
  );
});

test("a context-overflow retry stays on the model that failed", async () => {
  const h = harness({ difficulty: 2.6, config: TWO_FRONTIER });
  const first = await h.run("audit the routing design and tell me what is wrong with it");
  const retried = await h.run("", {
    reason: "retry",
    state: first.state,
    failed: {
      provider: ASTRA.provider,
      id: ASTRA.id,
      thinkingLevel: "medium",
      message: usageError("Your input exceeds the context window of this model.", ASTRA.id),
    },
  });
  assert.equal(retried.model, ASTRA);
  assert.equal(
    h.entries.some((entry) => entry.data?.outcome === "failover"),
    false,
  );
});

test("preview reports when the tier does not fit the current context", async () => {
  const h = harness({
    difficulty: 2.6,
    branch: [
      user("start on the big refactor task in this repository please"),
      assistant("Working through it.", { input: 2000, cacheRead: 450000 }),
    ],
  });
  await h.command("preview audit the routing design and tell me what is wrong with it");
  const text = h.notifications.at(-1).title;
  assert.match(text, /does not fit/);
  assert.match(text, /openai-codex\/gpt-6-astra/);
});

test("preview says the difficulty is unknown when the judge fails", async () => {
  const h = harness({
    askImpl: async () => {
      throw new Error("TYPESAFE_API_KEY is not set");
    },
  });
  await h.command("preview fix the typo in the readme");
  const text = h.notifications.at(-1).title;
  assert.match(text, /difficulty unknown/);
  assert.match(text, /ladder base Luna@medium/);
  assert.equal(h.askCount(), 1);
  await h.command("status");
  assert.match(h.notifications.at(-1).title, /0 turns/);
});

test("preview names cooled models it skipped without clearing them", async () => {
  const h = harness({ difficulty: 2.6, config: TWO_FRONTIER });
  await h.emit("agent_end", {
    messages: [
      usageError("You have hit your ChatGPT usage limit. Try again in ~20 min.", ASTRA.id),
    ],
  });
  await h.command("preview audit the routing design and tell me what is wrong with it");
  const text = h.notifications.at(-1).title;
  assert.match(text, /cooled down openai-codex\/gpt-6-astra/);
  assert.match(text, /pair openai-codex\/gpt-5\.6-sol @ medium/);
  const routed = await h.run("audit the routing design and tell me what is wrong with it");
  assert.equal(routed.model, SOL);
});

test("/route preview --json prints the dry run as JSON", async () => {
  const h = harness({ difficulty: 2.6 });
  await h.command("preview --json audit the routing design and tell me what is wrong");
  const body = JSON.parse(h.notifications.at(-1).title);
  assert.equal(body.difficulty, 2.6);
  assert.equal(body.tier, "frontier");
  assert.equal(body.pair.key, "openai-codex/gpt-6-astra");
  assert.equal(body.pair.thinking, "medium");
  assert.equal(body.contextFit.fits, true);
  assert.ok(body.stale.includes("grok-4.6"));
  assert.match(body.ladder, /frontier Astra@medium/);
  assert.equal(h.askArgs[0].state.prompt, "audit the routing design and tell me what is wrong");
  await h.command("status");
  assert.match(h.notifications.at(-1).title, /0 turns/);
});

test("/route preview reports a dry run and does not count as a turn", async () => {
  const h = harness({ difficulty: 1.6 });
  await h.command("preview fix the failing parser tests in the guardrail package");
  assert.equal(h.askCount(), 1);
  const text = h.notifications.at(-1).title;
  assert.match(text, /1\.60/);
  assert.match(text, /mid/);
  assert.match(text, /openai-codex\/gpt-6-astra/);
  assert.match(text, /low/);
  assert.match(text, /fits/);
  assert.match(text, /grok-4\.6/);
  assert.match(text, /base Luna@medium · mid Astra@low/);
  assert.equal(h.askArgs[0].state.prompt, "fix the failing parser tests in the guardrail package");
  await h.command("status");
  const status = h.notifications.at(-1).title;
  assert.match(status, /0 turns/);
  assert.match(status, /no judgement yet/);
  assert.match(status, /no routing decision yet/);
});

test("/route preview accepts a tier prefix and skips the judge", async () => {
  const h = harness({ difficulty: 0.6 });
  await h.command("preview !frontier audit the routing design and tell me what is wrong with it");
  assert.equal(h.askCount(), 0);
  const text = h.notifications.at(-1).title;
  assert.match(text, /forced frontier/);
  assert.match(text, /openai-codex\/gpt-6-astra/);
});

test("/route status shows the effective ladder at the current cap", async () => {
  const h = harness({ difficulty: 0.6 });
  await h.command("status");
  const status = h.notifications.at(-1).title;
  assert.match(status, /base Luna@medium · mid Astra@low · frontier Astra@medium/);
  assert.ok(!/mid collapses onto base/.test(status));
});

test("/route status shows mid and frontier on the same pair at the low cap", async () => {
  const h = harness({ difficulty: 0.6, thinkingLevel: "low" });
  await h.command("status");
  const status = h.notifications.at(-1).title;
  assert.match(status, /base Luna@low · mid Astra@low · frontier Astra@low/);
  assert.ok(!/mid collapses onto base/.test(status));
  assert.ok(!/mid is filtered out/.test(status));
});

test("a non-matching error retry stays on the model that failed", async () => {
  const h = harness({ difficulty: 2.6, config: TWO_FRONTIER });
  const first = await h.run("audit the routing design and tell me what is wrong with it");
  const retried = await h.run("", {
    reason: "retry",
    state: first.state,
    failed: {
      provider: ASTRA.provider,
      id: ASTRA.id,
      thinkingLevel: "medium",
      message: usageError("An error occurred while processing your request.", ASTRA.id),
    },
  });
  assert.equal(retried.model, ASTRA);
  assert.equal(
    h.entries.some((entry) => entry.data?.outcome === "failover"),
    false,
  );
});

test("!frontier forces the frontier tier without a difficulty judgement", async () => {
  const h = harness({ difficulty: 0.6, routerSelected: true });
  const transformed = await h.input(
    "!frontier audit the routing design and tell me what is wrong with it",
  );
  assert.deepEqual(transformed, {
    action: "transform",
    text: "audit the routing design and tell me what is wrong with it",
  });
  const routed = await h.run("audit the routing design and tell me what is wrong with it");
  assert.equal(routed.model, ASTRA);
  assert.equal(routed.state.tier, "frontier");
  assert.equal(h.askCount(), 0);
  const entry = h.entries.find((e) => e.customType === "router-decision");
  assert.equal(entry.data.outcome, "forced");
  assert.equal(entry.data.tier, "frontier");
});

test("a forced tier holds on continuations until the next task boundary", async () => {
  const h = harness({ difficulty: 0.6, routerSelected: true });
  await h.input("!frontier audit the routing design and tell me what is wrong with it");
  const first = await h.run("audit the routing design and tell me what is wrong with it");
  assert.equal(first.state.forcedTier, "frontier");
  const held = await h.run("keep going", {
    reason: "continuation",
    state: first.state,
    previous: { provider: ASTRA.provider, id: ASTRA.id, thinkingLevel: "medium" },
    messages: [
      user("audit the routing design and tell me what is wrong with it"),
      assistant("ok"),
      user("keep going"),
    ],
  });
  assert.equal(held.state.forcedTier, "frontier");
  assert.equal(h.askCount(), 0);
});

test("a forced tier clears at the next task boundary without a prefix", async () => {
  const h = harness({ difficulty: 0.6, routerSelected: true });
  await h.input("!frontier audit the routing design and tell me what is wrong with it");
  const first = await h.run("audit the routing design and tell me what is wrong with it");
  const next = await h.run(
    "start a completely new task rewriting the deploy pipeline notes for a brand new reader",
    {
      state: first.state,
      messages: [
        ...turn("audit the routing design and tell me what is wrong with it"),
        user(
          "start a completely new task rewriting the deploy pipeline notes for a brand new reader",
        ),
      ],
    },
  );
  assert.equal(next.model, LUNA);
  assert.equal(next.state.forcedTier, null);
  assert.equal(h.askCount(), 1);
});

test("bare !frontier is handled and does not send an empty prompt", async () => {
  const h = harness({ routerSelected: true });
  const result = await h.input("!frontier");
  assert.deepEqual(result, { action: "handled" });
  assert.match(h.notifications.at(-1).title, /not sent|after !base/i);
  assert.equal(h.askCount(), 0);
});

test("tier prefixes are ignored when a physical model is selected", async () => {
  const h = harness({ difficulty: 0.6, routerSelected: false });
  const result = await h.input("!frontier audit the routing design");
  assert.equal(result, undefined);
});
