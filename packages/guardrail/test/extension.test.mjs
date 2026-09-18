// End-to-end tests for the extension entry: a fake pi and a fake UI drive the
// real tool_call handler, so the whole path is exercised — policy, script
// reading, judge fallback, dialog, block reason, kill switch.
//
// The judge is kept off the network by pointing both key sources at nothing:
// any call to TypeSafe fails fast, which is also the failure mode worth
// testing (a guardrail that cannot ask must not quietly allow).

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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

function harness({ hasUI = true, cwd = process.cwd(), choices = [], inputs = [] } = {}) {
  const handlers = {};
  const commands = {};
  const dialogs = [];
  const notifications = [];
  const pi = {
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
      return choices.shift();
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
  };

  piGuardrailExtension(pi);

  return {
    dialogs,
    notifications,
    run: (toolName, input) => handlers.tool_call[0]({ toolName, input }, ctx),
    command: (args) => commands.guardrail.handler(args, ctx),
  };
}

// ---------------------------------------------------------------------------

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

test.after?.(() => {
  for (const [key, value] of Object.entries(ENV_BACKUP)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
