// Playbooks: the task-type judgement, the files it selects, and the
// before_agent_start wiring — one judgement per task, nothing injected when
// the judge is unsure or unavailable, and route() reusing the same call.

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import piRouterExtension from "../index.ts";
import {
  loadPlaybook,
  NO_PLAYBOOK,
  PLAYBOOK_TYPES,
  taskTypeFromAnswer,
  withPlaybook,
} from "../playbook.mjs";

const SAVED = {
  PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD,
  PI_ROUTER_PLAYBOOKS: process.env.PI_ROUTER_PLAYBOOKS,
};
const tempDirs = [];

beforeEach(() => {
  for (const key of Object.keys(SAVED)) delete process.env[key];
});

after(() => {
  for (const [key, value] of Object.entries(SAVED)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const choice = (value, p) => ({
  type: "choice",
  choice: value,
  ...(p === undefined ? {} : { probabilities: { [value]: p } }),
});

test("every playbook type has a short file", () => {
  for (const type of PLAYBOOK_TYPES) {
    const text = loadPlaybook(type);
    assert.ok(text, `${type}.md is missing or empty`);
    const steps = text.split("\n").filter((line) => /^\d+\. /.test(line));
    assert.ok(steps.length >= 5 && steps.length <= 8, `${type} has ${steps.length} steps`);
  }
  assert.equal(loadPlaybook(NO_PLAYBOOK), null);
  assert.equal(loadPlaybook("../../package"), null);
});

test("the task type is the chosen option, or none when unsure or unknown", () => {
  assert.equal(taskTypeFromAnswer(choice("bug", 0.9)), "bug");
  assert.equal(taskTypeFromAnswer(choice("bug")), "bug");
  assert.equal(taskTypeFromAnswer(choice("bug", 0.3)), NO_PLAYBOOK);
  assert.equal(taskTypeFromAnswer(choice("deploy", 0.9)), NO_PLAYBOOK);
  assert.equal(taskTypeFromAnswer({ type: "score", score: 2 }), NO_PLAYBOOK);
  assert.equal(taskTypeFromAnswer(undefined), NO_PLAYBOOK);
});

test("withPlaybook appends and leaves the prompt alone without text", () => {
  assert.equal(withPlaybook("base", null), "base");
  assert.equal(withPlaybook("base", "## P"), "base\n\n## P");
});

const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text = "done") => ({ role: "assistant", content: [{ type: "text", text }] });
const LUNA = { provider: "openai-codex", id: "gpt-5.6-luna" };

function harness({ answers, fail = false, selected = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "router-playbook-"));
  tempDirs.push(dir);
  const handlers = {};
  const entries = [];
  const statuses = [];
  const asks = [];
  let virtualModel = null;
  let branch = [];
  const pi = {
    on: (name, fn) => {
      handlers[name] = fn;
    },
    registerCommand: () => {},
    appendEntry: (customType, data) => entries.push({ customType, data }),
    registerVirtualModel: (def) => {
      virtualModel = def;
    },
  };
  const ctx = {
    cwd: dir,
    get model() {
      return selected;
    },
    modelRegistry: { getAvailable: () => [LUNA], find: () => LUNA, getModel: () => LUNA },
    sessionManager: { getBranch: () => branch },
    ui: { notify: () => {}, setStatus: (id, text) => statuses.push({ id, text }) },
  };
  piRouterExtension(pi, {
    configPath: path.join(dir, "router.json"),
    ask: async (input) => {
      asks.push(input);
      if (fail) throw new Error("no key");
      return { answers: answers(input) };
    },
  });
  return {
    asks,
    entries,
    statuses,
    setBranch: (messages) => {
      branch = messages.map((message) => ({ type: "message", message }));
    },
    start: (prompt) => handlers.before_agent_start({ prompt, systemPrompt: "BASE" }, ctx),
    route: (prompt, messages) =>
      virtualModel.route({ reason: "user", thinkingLevel: "medium", messages }, ctx),
  };
}

test("a bug report gets the bug playbook in the system prompt", async () => {
  const h = harness({ answers: () => ({ task_type: choice("bug", 0.8) }) });
  const result = await h.start("the export command throws on empty input, fix it");
  assert.match(result.systemPrompt, /^BASE\n\n## Playbook: bug fix/);
  assert.deepEqual(Object.keys(h.asks[0].questions), ["task_type"]);
  assert.deepEqual(h.statuses.at(-1), { id: "playbook", text: "playbook: bug" });
  assert.equal(h.entries.at(-1).customType, "router-playbook");
});

test("none, an unsure answer, or a dead judge inject nothing", async () => {
  for (const h of [
    harness({ answers: () => ({ task_type: choice("none", 0.9) }) }),
    harness({ answers: () => ({ task_type: choice("feature", 0.2) }) }),
    harness({ fail: true }),
  ]) {
    assert.equal(await h.start("what time is it in tokyo"), undefined);
  }
});

test("a continuation keeps the playbook without judging again", async () => {
  const h = harness({ answers: () => ({ task_type: choice("refactor", 0.9) }) });
  const first = "refactor the session parser so the three readers share one tokenizer";
  await h.start(first);
  h.setBranch([user(first), assistant("done the first pass")]);
  const again = await h.start("also the tokenizer tests");
  assert.equal(h.asks.length, 1);
  assert.match(again.systemPrompt, /## Playbook: refactor/);
});

test("a new task is judged again and can drop the playbook", async () => {
  let type = "investigation";
  const h = harness({ answers: () => ({ task_type: choice(type, 0.9) }) });
  await h.start("how does the compaction judge decide what to keep");
  h.setBranch([user("how does the compaction judge decide what to keep"), assistant("it ranks")]);
  type = "none";
  const next = await h.start("completely different: which weekday was 1 march 2020 in london");
  assert.equal(h.asks.length, 2);
  assert.equal(next, undefined);
});

test("subagent children and PI_ROUTER_PLAYBOOKS=off never judge", async () => {
  process.env.PI_SUBAGENT_CHILD = "1";
  const child = harness({ answers: () => ({ task_type: choice("bug", 0.9) }) });
  assert.equal(await child.start("fix the failing test"), undefined);
  delete process.env.PI_SUBAGENT_CHILD;
  process.env.PI_ROUTER_PLAYBOOKS = "off";
  const off = harness({ answers: () => ({ task_type: choice("bug", 0.9) }) });
  assert.equal(await off.start("fix the failing test"), undefined);
  assert.equal(child.asks.length + off.asks.length, 0);
});

test("with router/auto selected, one call rates both and route() reuses it", async () => {
  const h = harness({
    selected: { provider: "router", id: "auto" },
    answers: () => ({
      task_type: choice("feature", 0.9),
      difficulty: { type: "score", score: 0.4 },
    }),
  });
  const prompt = "add a --json flag to the status command";
  await h.start(prompt);
  assert.ok("difficulty" in h.asks[0].questions);
  await h.route(prompt, [user(prompt)]);
  assert.equal(h.asks.length, 1);
});
