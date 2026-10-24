// End-to-end tests for the extension entry: a fake pi and a fake UI drive the
// real tool_call handler, so the whole path is exercised — policy, script
// reading, judge fallback, dialog, block reason, kill switch.
//
// The judge is kept off the network by pointing both key sources at nothing:
// any call to TypeSafe fails fast, which is also the failure mode worth
// testing (a guardrail that cannot ask must not quietly allow).

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import piGuardrailExtension from "../index.ts";

const APPROVE = "✅ Approve";
const DENY = "⛔ Deny";
const SUGGEST = "✏️ Suggest an alternative";

const ENV_BACKUP = {
  TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
  TYPESAFE_BASE_URL: process.env.TYPESAFE_BASE_URL,
  LORE_CONFIG: process.env.LORE_CONFIG,
  PI_GUARDRAIL: process.env.PI_GUARDRAIL,
};

beforeEach(() => {
  // A key that cannot reach anywhere: the judge fails fast and deterministically
  // so these tests exercise the failure path instead of spending tokens.
  process.env.TYPESAFE_API_KEY = "guardrail-test-key";
  process.env.TYPESAFE_BASE_URL = "http://127.0.0.1:9/v1";
  process.env.LORE_CONFIG = join(tmpdir(), "guardrail-test-no-such-config.json");
  delete process.env.PI_GUARDRAIL;
});

function harness({
  hasUI = true,
  cwd = process.cwd(),
  choices = [],
  inputs = [],
  tools = [],
  modelRegistry,
} = {}) {
  const handlers = {};
  const commands = {};
  const dialogs = [];
  const notifications = [];
  const pi = {
    getAllTools: () => tools,
    on: (name, handler) => {
      (handlers[name] ??= []).push(handler);
    },
    registerCommand: (name, def) => {
      commands[name] = def;
    },
  };
  const ui = {
    select: async (title, options) => {
      dialogs.push({ title, options });
      const choice = choices.shift();
      return typeof choice === "function" ? choice() : choice;
    },
    input: async (title, placeholder) => {
      dialogs.push({ title, placeholder });
      return inputs.shift();
    },
    notify: (title, level) => notifications.push({ title, level }),
  };
  const ctx = {
    hasUI,
    cwd,
    ui,
    sessionManager: { getBranch: () => [{ message: { role: "user", content: "do the thing" } }] },
    ...(modelRegistry ? { modelRegistry } : {}),
  };

  piGuardrailExtension(pi);

  return {
    dialogs,
    notifications,
    run: (toolName, input) => handlers.tool_call[0]({ toolName, input }, ctx),
    command: (args) => commands.guardrail.handler(args, ctx),
    input: async () => {
      for (const fn of handlers.input ?? []) await fn({}, ctx);
    },
    session: async () => {
      for (const fn of handlers.session_start ?? []) await fn({}, ctx);
    },
    setCwd: (nextCwd) => {
      ctx.cwd = nextCwd;
    },
  };
}

// ---------------------------------------------------------------------------

test("an outside read-only claim is still inspected", async () => {
  const h = harness({
    tools: [
      {
        name: "custom_reader",
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
    ],
  });
  const result = await h.run("custom_reader", { command: "rm -rf ~" });
  assert.equal(result.block, true);
  assert.match(result.reason, /refusing to delete/);
  assert.equal(h.dialogs.length, 0);
});

test("this repo's own reader is not inspected", async () => {
  const h = harness({
    tools: [
      {
        name: "code_search",
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
    ],
  });
  assert.equal(await h.run("code_search", { command: "rm -rf ~" }), undefined);
  assert.equal(h.dialogs.length, 0);
});

test("a declared writer is inspected even when the name looks read-only", async () => {
  const h = harness({
    tools: [
      {
        name: "get_secret",
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      },
    ],
  });
  const result = await h.run("get_secret", { path: "~/.ssh/id_rsa" });
  assert.equal(result.block, true);
  assert.match(result.reason, /credential or VCS internals/);
  assert.equal(h.dialogs.length, 0);
});

test("a routine command passes through in silence", async () => {
  const h = harness();
  assert.equal(await h.run("bash", { command: "rm -rf node_modules && npm install" }), undefined);
  assert.equal(h.dialogs.length, 0);
});

test("the catastrophic set is refused without a dialog", async () => {
  const h = harness();
  const result = await h.run("bash", { command: "rm -rf ~" });
  assert.equal(result.block, true);
  assert.match(result.reason, /refusing to delete ~/);
  assert.match(result.reason, /do not retry/i);
  assert.equal(h.dialogs.length, 0, "a refusal must not ask a question");
});

test("approving a flagged call lets it run", async () => {
  const h = harness({ choices: [APPROVE] });
  assert.equal(await h.run("bash", { command: "pkill node" }), undefined);
  assert.equal(h.dialogs.length, 1);
  assert.deepEqual(h.dialogs[0].options, [APPROVE, DENY, SUGGEST]);
  assert.match(h.dialogs[0].title, /🛑 Guardrail/);
  assert.match(h.dialogs[0].title, /pkill node/);
});

test("denying returns a reason the model can act on", async () => {
  const h = harness({ choices: [DENY] });
  const result = await h.run("bash", { command: "rm -rf ~/Documents/notes" });
  assert.equal(result.block, true);
  assert.ok(result.reason.includes("Refused by the user"), result.reason);
});

test("suggesting an alternative carries the suggestion back to the model", async () => {
  const h = harness({
    choices: [SUGGEST],
    inputs: ["delete only the dist folder in this project"],
  });
  const result = await h.run("bash", { command: "rm -rf ~/Documents/projects/other-repo" });
  assert.equal(result.block, true);
  assert.match(result.reason, /delete only the dist folder in this project/);
  assert.equal(h.dialogs.length, 2);
  assert.match(h.dialogs[1].title, /instead/);
});

test("an empty suggestion still refuses the original call", async () => {
  const h = harness({ choices: [SUGGEST], inputs: [""] });
  const result = await h.run("bash", { command: "git reset --hard" });
  assert.equal(result.block, true);
  assert.match(result.reason, /chose not to describe an alternative/);
});

test("a cancelled dialog refuses rather than assuming approval", async () => {
  const h = harness({ choices: [undefined] });
  const result = await h.run("bash", { command: "git reset --hard" });
  assert.equal(result.block, true);
});

test("with no UI the flagged band is refused, never waved through", async () => {
  const h = harness({ hasUI: false });
  const result = await h.run("bash", { command: "rm -rf ~/Documents/notes" });
  assert.equal(result.block, true);
  assert.equal(h.dialogs.length, 0);
});

test("the ambiguous band uses Pi classify when a TypeSafe classifier is registered", async () => {
  const calls = [];
  const modelRegistry = {
    findOfType() {
      return undefined;
    },
    getModelsOfType() {
      return [
        {
          id: "jev-latest",
          type: "classifier",
          provider: "typesafe",
          api: "typesafe-system-one",
          baseUrl: "https://api.typesafe.ai/v1",
        },
      ];
    },
    async classify(_model, context) {
      calls.push(context);
      const answers = {};
      for (const [id, question] of Object.entries(context.questions ?? {})) {
        answers[id] =
          question.type === "score"
            ? { type: "score", score: 0 }
            : { type: "bool", probability: 0.05 };
      }
      return {
        stopReason: "stop",
        answers,
        usage: {
          input: 3,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 4,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
    },
  };
  const h = harness({ hasUI: false, modelRegistry });
  const result = await h.run("bash", { command: "rm src/app.ts" });
  assert.equal(calls.length, 1, "the guardrail did not call classify");
  assert.equal(result, undefined);
});

test("the judge is consulted for the ambiguous band and its absence fails closed", async () => {
  const h = harness({ hasUI: false });
  // A workspace delete is a judgment, not a rule: with no judge reachable and
  // no human to ask, it must refuse rather than allow.
  const result = await h.run("bash", { command: "rm src/app.ts" });
  assert.equal(result.block, true);
  assert.match(result.reason, /no interactive UI|judge unavailable/i, result.reason);
});

test("script indirection is followed: a destructive script escalates", async () => {
  const dir = mkdtempSync(join(tmpdir(), "guardrail-"));
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(
      join(dir, "scripts", "deploy.mjs"),
      "import { rmSync } from 'node:fs';\nrmSync('build', { recursive: true });\n",
    );
    const h = harness({ cwd: dir, hasUI: false });
    const result = await h.run("bash", { command: "node scripts/deploy.mjs" });
    assert.equal(result.block, true, "a script that deletes should not pass unread");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a clean script does not escalate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "guardrail-"));
  try {
    mkdirSync(join(dir, "scripts"), { recursive: true });
    writeFileSync(join(dir, "scripts", "build.mjs"), "console.log('building');\n");
    const h = harness({ cwd: dir, hasUI: false });
    assert.equal(await h.run("bash", { command: "node scripts/build.mjs" }), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("editing a secret is refused without asking", async () => {
  const h = harness();
  const result = await h.run("write", { path: "~/.ssh/authorized_keys", content: "ssh-rsa AAAA" });
  assert.equal(result.block, true);
  assert.equal(h.dialogs.length, 0);
});

test("the kill switch turns the guardrail off for the session", async () => {
  const h = harness();
  await h.command("off");
  assert.equal(await h.run("bash", { command: "rm -rf ~" }), undefined);
  await h.command("on");
  assert.equal((await h.run("bash", { command: "rm -rf ~" })).block, true);
});

test("status reports what happened this session", async () => {
  const h = harness({ choices: [DENY] });
  await h.run("bash", { command: "git status" });
  await h.run("bash", { command: "pkill node" });
  await h.command("status");
  const last = h.notifications.at(-1).title;
  assert.match(last, /Guardrail on/);
  assert.match(last, /1 asked/);
  assert.match(last, /1 refused/);
});

test("authorization is scoped to an exact external action, target, cwd and input", async () => {
  const h = harness({ cwd: "/work/one", choices: [APPROVE, DENY, DENY, DENY] });
  const input = { command: "git push origin main" };
  assert.equal(await h.run("bash", input), undefined);
  assert.equal(await h.run("bash", input), undefined);
  assert.equal(h.dialogs.length, 1);
  assert.equal((await h.run("bash", { command: "git push other main" })).block, true);
  h.setCwd("/work/two");
  assert.equal((await h.run("bash", input)).block, true);
  h.setCwd("/work/one");
  await h.input();
  assert.equal((await h.run("bash", input)).block, true);
  assert.equal(h.dialogs.length, 4);
});

test("control-plane approval covers the file, not sibling files; revoke clears it", async () => {
  const h = harness({ choices: [APPROVE, DENY, DENY] });
  const path = join(process.env.HOME, ".pi/agent/settings.json");
  assert.equal(await h.run("write", { path, content: "{}" }), undefined);
  assert.equal(await h.run("edit", { path, edits: [{ oldText: "a", newText: "b" }] }), undefined);
  assert.equal(h.dialogs.length, 1);
  assert.match(h.dialogs[0].title, /scope/i);
  assert.equal(
    (await h.run("write", { path: join(process.env.HOME, ".pi/agent/router.json"), content: "{}" }))
      .block,
    true,
  );
  await h.command("revoke");
  assert.equal((await h.run("write", { path, content: "{}" })).block, true);
});

test("concurrent identical calls share one approval, but pending old approvals cannot survive new input", async () => {
  const h = harness({ choices: [APPROVE] });
  const call = { command: "gh pr merge 42 --squash" };
  assert.deepEqual(await Promise.all([h.run("bash", call), h.run("bash", call)]), [
    undefined,
    undefined,
  ]);
  assert.equal(h.dialogs.length, 1);
  let resolve;
  const stale = harness({
    choices: [
      () =>
        new Promise((done) => {
          resolve = done;
        }),
      DENY,
    ],
  });
  const pending = stale.run("bash", call);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(typeof resolve, "function");
  await stale.input();
  resolve(APPROVE);
  assert.equal((await pending).block, true);
  assert.equal((await stale.run("bash", call)).block, true);
});

test("missing UI, cancellation and catastrophic patterns cannot use scoped approval", async () => {
  for (const hasUI of [true, false]) {
    const h = harness({ hasUI, choices: [undefined] });
    assert.equal((await h.run("bash", { command: "terraform apply -auto-approve" })).block, true);
  }
  const h = harness({ choices: [APPROVE] });
  await h.run("bash", { command: "git push origin main" });
  assert.equal((await h.run("bash", { command: "git push origin main && rm -rf ~" })).block, true);
  await h.session();
  assert.equal((await h.run("bash", { command: "git push origin main" })).block, true);
});

test("remote annotations override reader-like names and require approval without a UI", async () => {
  const h = harness({
    hasUI: false,
    tools: [
      {
        name: "mcp__cloud__get_and_delete",
        namespace: { name: "cloud" },
        annotations: { readOnlyHint: false },
      },
      {
        name: "mcp__cloud__get",
        namespace: { name: "cloud" },
        annotations: { readOnlyHint: true },
      },
      { name: "mcp__cloud__deploy", namespace: { name: "cloud" } },
    ],
  });
  assert.equal((await h.run("mcp__cloud__get_and_delete", { id: "one" })).block, true);
  assert.equal((await h.run("mcp__cloud__deploy", { id: "one" })).block, true);
  assert.equal(await h.run("mcp__cloud__get", { id: "one" }), undefined);
});

test("symlink aliases of control files are protected", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "guardrail-link-"));
  const agent = join(root, "agent");
  const previousAgent = process.env.PI_CODING_AGENT_DIR;
  mkdirSync(agent);
  process.env.PI_CODING_AGENT_DIR = agent;
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    if (previousAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgent;
  });

  writeFileSync(join(agent, "settings.json"), "{}");
  symlinkSync(join(agent, "settings.json"), join(root, "alias"));
  symlinkSync(join(agent, "models.json"), join(root, "dangling"));
  const h = harness({ cwd: root, hasUI: false });
  assert.equal((await h.run("write", { path: "alias", content: "{}" })).block, true);
  // A dangling link still names a control file; writing through it must not
  // create that file without approval.
  assert.equal((await h.run("write", { path: "dangling", content: "{}" })).block, true);
});

test.after?.(() => {
  for (const [key, value] of Object.entries(ENV_BACKUP)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
