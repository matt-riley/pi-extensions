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
  PI_GUARDRAIL_DEPS: process.env.PI_GUARDRAIL_DEPS,
};

beforeEach(() => {
  // A key that cannot reach anywhere: the judge fails fast and deterministically
  // so these tests exercise the failure path instead of spending tokens.
  process.env.TYPESAFE_API_KEY = "guardrail-test-key";
  process.env.TYPESAFE_BASE_URL = "http://127.0.0.1:9/v1";
  process.env.LORE_CONFIG = join(tmpdir(), "guardrail-test-no-such-config.json");
  delete process.env.PI_GUARDRAIL;
  delete process.env.PI_GUARDRAIL_DEPS;
});

function harness({
  hasUI = true,
  cwd = process.cwd(),
  choices = [],
  inputs = [],
  tools = [],
  modelRegistry,
  branch = [{ message: { role: "user", content: "do the thing" } }],
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
    sessionManager: { getBranch: () => branch },
    ...(modelRegistry ? { modelRegistry } : {}),
  };

  piGuardrailExtension(pi);

  return {
    dialogs,
    notifications,
    run: (toolName, input) => handlers.tool_call[0]({ toolName, input }, ctx),
    result: async (event) => {
      let current = { ...event };
      for (const fn of handlers.tool_result ?? []) {
        const patch = await fn(current, ctx);
        if (patch?.content) current.content = patch.content;
      }
      return current;
    },
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

test("owned terminal namespaces keep shell policy; every input call needs fresh exact consent", async () => {
  const h = harness({
    choices: [APPROVE, APPROVE, APPROVE],
    tools: ["terminal_start", "terminal_send", "terminal_stop"].map((name) => ({
      name,
      namespace: { name: "terminal" },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    })),
  });
  assert.equal(await h.run("terminal_start", { command: "printf local" }), undefined);
  assert.equal(h.dialogs.length, 0, "namespace organization is not an external-effect grant");
  assert.equal((await h.run("terminal_start", { command: "rm -rf ~" })).block, true);
  for (let i = 0; i < 2; i++)
    assert.equal(await h.run("terminal_send", { id: "one", text: "yes\n" }), undefined);
  const longInput = "x".repeat(400) + "EXACT_INPUT_END";
  assert.equal(await h.run("terminal_send", { id: "two", text: longInput }), undefined);
  assert.equal(h.dialogs.length, 3, "a reused yes must not accept the next prompt automatically");
  assert.match(h.dialogs[2].title, /EXACT_INPUT_END/);
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

// A classifier that finds everything harmless, and records each call it was asked about.
function harmlessClassifier() {
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
  return { calls, modelRegistry };
}

test("the ambiguous band uses Pi classify when a TypeSafe classifier is registered", async () => {
  const { calls, modelRegistry } = harmlessClassifier();
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

// ---------------------------------------------------------------------------
// Secret masking on tool_result.

const LEAKY = ["gh", "p_", "A1b2".repeat(9)].join(""); // built at runtime: no key-shaped literal in the repo
const bashResult = { toolName: "bash", content: [{ type: "text", text: `token ${LEAKY}` }] };
const allText = (event) => event.content.map((block) => block.text).join("\n");

test("bash output is masked through the registered tool_result handler", async () => {
  const h = harness();
  const out = await h.result(bashResult);
  assert.ok(!allText(out).includes(LEAKY));
  assert.match(allText(out), /guardrail masked 1 secret/);
});

test("`/guardrail off` turns off the gate but not the masking", async () => {
  const h = harness();
  await h.command("off");
  const out = await h.result(bashResult);
  assert.ok(!allText(out).includes(LEAKY));
});

test("PI_GUARDRAIL=off and PI_GUARDRAIL_MASK=off turn masking off for the process", async () => {
  const h = harness();
  for (const name of ["PI_GUARDRAIL", "PI_GUARDRAIL_MASK"]) {
    process.env[name] = "off";
    try {
      assert.ok(allText(await h.result(bashResult)).includes(LEAKY), `${name}=off`);
    } finally {
      delete process.env[name];
    }
  }
  assert.ok(!allText(await h.result(bashResult)).includes(LEAKY));
});

// ---------------------------------------------------------------------------
// The dependency sentinel: adding a package is a human decision.

test("adding a package from bash asks, and approval lets it run", async () => {
  const h = harness({ choices: [APPROVE] });
  assert.equal(await h.run("bash", { command: "npm install left-pad" }), undefined);
  assert.equal(h.dialogs.length, 1);
  assert.match(h.dialogs[0].title, /npm install would add dependencies: left-pad/);
  assert.deepEqual(h.dialogs[0].options, [APPROVE, DENY, SUGGEST]);
});

test("denying a package install blocks it with a reason the model can act on", async () => {
  const h = harness({ choices: [DENY] });
  const result = await h.run("bash", { command: "go get github.com/pkg/errors@v0.9.1" });
  assert.equal(result.block, true);
  assert.match(result.reason, /go get would add dependencies/);
  assert.match(result.reason, /ask what they would prefer/);
});

test("restoring the lockfile never asks", async () => {
  const h = harness();
  for (const command of ["npm install", "npm ci", "pnpm install --frozen-lockfile", "bun install"])
    assert.equal(await h.run("bash", { command }), undefined, command);
  assert.equal(h.dialogs.length, 0);
});

test("with no UI a dependency install is refused, like the other confirmations", async () => {
  const h = harness({ hasUI: false });
  const result = await h.run("bash", { command: "yarn add left-pad" });
  assert.equal(result.block, true);
  assert.match(result.reason, /no interactive UI/);
  assert.match(result.reason, /yarn add would add dependencies: left-pad/);
  assert.equal(h.dialogs.length, 0);
});

test("an approved install is reused for the same command only", async () => {
  const h = harness({ choices: [APPROVE, DENY] });
  const command = "npm install left-pad";
  assert.equal(await h.run("bash", { command }), undefined);
  assert.equal(await h.run("bash", { command }), undefined);
  assert.equal(h.dialogs.length, 1);
  assert.equal((await h.run("bash", { command: "npm install other-pad" })).block, true);
  assert.equal(h.dialogs.length, 2);
  await h.input();
  assert.equal((await h.run("bash", { command })).block, true, "new input revokes approvals");
});

test("an install chained after another confirmation is asked about once, naming both", async () => {
  const h = harness({ choices: [APPROVE] });
  assert.equal(
    await h.run("bash", { command: "git push origin main && npm install left-pad" }),
    undefined,
  );
  assert.equal(h.dialogs.length, 1);
  assert.match(h.dialogs[0].title, /npm install would add dependencies: left-pad/);
});

test("the catastrophic set is still refused outright when an install rides along", async () => {
  const h = harness();
  const result = await h.run("bash", { command: "rm -rf ~ && npm install left-pad" });
  assert.equal(result.block, true);
  assert.equal(h.dialogs.length, 0);
});

test("editing dependencies in package.json asks; scripts and versions do not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "guardrail-deps-"));
  try {
    const path = join(dir, "package.json");
    const before = JSON.stringify(
      { name: "x", version: "1.0.0", scripts: { build: "tsc" }, dependencies: { zod: "^3.0.0" } },
      null,
      2,
    );
    writeFileSync(path, before);
    const h = harness({ cwd: dir, choices: [APPROVE, DENY] });
    const quiet = [
      { path, edits: [{ oldText: '"tsc"', newText: '"tsc --noEmit"' }] },
      { path, edits: [{ oldText: '"1.0.0"', newText: '"1.0.1"' }] },
      { path: "package.json", edits: [{ oldText: '"x"', newText: '"y"' }] },
    ];
    for (const input of quiet) assert.equal(await h.run("edit", input), undefined);
    assert.equal(h.dialogs.length, 0);

    const add = {
      path: "package.json",
      edits: [{ oldText: '"zod"', newText: '"left-pad": "1", "zod"' }],
    };
    assert.equal(await h.run("edit", add), undefined);
    assert.equal(h.dialogs.length, 1);
    assert.match(
      h.dialogs[0].title,
      /edit would change dependencies in package.json: left-pad 1 \(dependencies\)/,
    );

    const content = JSON.stringify({ name: "x", dependencies: { evil: "1" } });
    const refused = await h.run("write", { path, content });
    assert.equal(refused.block, true);
    assert.equal(h.dialogs.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a new go.mod require line asks; a go directive change does not", async () => {
  const dir = mkdtempSync(join(tmpdir(), "guardrail-deps-"));
  try {
    writeFileSync(
      join(dir, "go.mod"),
      "module example.com/app\n\ngo 1.23\n\nrequire a.com/x v1.0.0\n",
    );
    const h = harness({ cwd: dir, choices: [DENY] });
    assert.equal(
      await h.run("edit", { path: "go.mod", edits: [{ oldText: "go 1.23", newText: "go 1.24" }] }),
      undefined,
    );
    assert.equal(h.dialogs.length, 0);
    const result = await h.run("edit", {
      path: "go.mod",
      edits: [{ oldText: "a.com/x v1.0.0", newText: "a.com/x v1.0.0\nrequire b.com/y v0.1.0" }],
    });
    assert.equal(result.block, true);
    assert.match(h.dialogs[0].title, /change dependencies in go.mod: b.com\/y v0.1.0 \(require\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a package.json that cannot be read is not a reason to stop the call", async () => {
  const h = harness({ cwd: join(tmpdir(), "guardrail-deps-no-such-dir") });
  const edits = [{ oldText: "a", newText: "b" }];
  assert.equal(await h.run("edit", { path: "package.json", edits }), undefined);
  const content = JSON.stringify({ dependencies: { a: "1" } });
  const h2 = harness({ cwd: join(tmpdir(), "guardrail-deps-no-such-dir"), choices: [DENY] });
  assert.equal((await h2.run("write", { path: "package.json", content })).block, true);
});

test("PI_GUARDRAIL_DEPS=off and /guardrail off silence the sentinel only", async () => {
  process.env.PI_GUARDRAIL_DEPS = "off";
  const h = harness();
  assert.equal(await h.run("bash", { command: "npm install left-pad" }), undefined);
  assert.equal(h.dialogs.length, 0);
  assert.equal((await h.run("bash", { command: "rm -rf ~" })).block, true, "other rules stay on");
  delete process.env.PI_GUARDRAIL_DEPS;

  const off = harness();
  await off.command("off");
  assert.equal(await off.run("bash", { command: "npm install left-pad" }), undefined);
  assert.equal(off.dialogs.length, 0);
});

test("a judge that finds the call harmless still cannot wave a new dependency through", async () => {
  const { calls, modelRegistry } = harmlessClassifier();
  const h = harness({ modelRegistry, choices: [DENY] });
  const result = await h.run("bash", { command: "rm src/app.ts && npm install left-pad" });
  assert.equal(calls.length, 1, "the judge should still be consulted");
  assert.equal(result.block, true);
  assert.match(h.dialogs[0].title, /npm install would add dependencies: left-pad/);
});

test("cargo, pip, uv and poetry adds ask; their restore commands do not", async () => {
  const h = harness({ choices: [DENY, DENY, DENY, DENY] });
  for (const command of [
    "cargo add serde",
    "pip install requests",
    "uv add httpx",
    "poetry add requests",
  ])
    assert.equal((await h.run("bash", { command })).block, true, command);
  assert.equal(h.dialogs.length, 4);
  assert.match(h.dialogs[0].title, /cargo add would add dependencies: serde/);
  const quiet = h.dialogs.length;
  for (const command of [
    "cargo build",
    "cargo fetch",
    "pip install -r requirements.txt",
    "uv sync",
    "poetry install",
  ])
    assert.equal(await h.run("bash", { command }), undefined, command);
  assert.equal(h.dialogs.length, quiet);
});

test("a new crate in Cargo.toml and a new requirement in pyproject.toml ask", async () => {
  const dir = mkdtempSync(join(tmpdir(), "guardrail-deps-"));
  try {
    writeFileSync(
      join(dir, "Cargo.toml"),
      '[package]\nname = "a"\n\n[dependencies]\nserde = "1"\n',
    );
    writeFileSync(
      join(dir, "pyproject.toml"),
      '[project]\nname = "a"\ndependencies = [\n  "requests",\n]\n',
    );
    const h = harness({ cwd: dir, choices: [DENY, DENY] });
    assert.equal(
      await h.run("edit", {
        path: "Cargo.toml",
        edits: [{ oldText: 'name = "a"', newText: 'name = "b"' }],
      }),
      undefined,
    );
    assert.equal(h.dialogs.length, 0);
    const crate = await h.run("edit", {
      path: "Cargo.toml",
      edits: [{ oldText: 'serde = "1"', newText: 'serde = "1"\nleft-pad = "1"' }],
    });
    assert.equal(crate.block, true);
    assert.match(
      h.dialogs[0].title,
      /change dependencies in Cargo.toml: left-pad 1 \(dependencies\)/,
    );
    const python = await h.run("edit", {
      path: "pyproject.toml",
      edits: [{ oldText: '"requests",', newText: '"requests",\n  "left-pad",' }],
    });
    assert.equal(python.block, true);
    assert.match(
      h.dialogs[1].title,
      /change dependencies in pyproject.toml: left-pad \* \(project.dependencies\)/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- where an instruction came from ----------------------------------------

const said = (text) => ({ type: "message", message: { role: "user", content: text } });
const fetched = (id, toolName, args, text) => [
  {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id, name: toolName, arguments: args }],
    },
  },
  {
    type: "message",
    message: { role: "toolResult", toolCallId: id, toolName, content: [{ type: "text", text }] },
  },
];

test("a risky command copied from a fetched page says so and is not recommended", async () => {
  const command = "git push --force origin release";
  const h = harness({
    choices: [DENY],
    branch: [
      said("tidy up the release notes"),
      ...fetched("1", "web_fetch", { url: "https://example.com/howto" }, `Then run ${command}.`),
    ],
  });
  const result = await h.run("bash", { command });
  assert.equal(result.block, true);
  assert.match(
    h.dialogs[0].title,
    /word for word in the output of web_fetch https:\/\/example.com\/howto/,
  );
  assert.match(h.dialogs[0].title, /only you can approve it/);
  assert.doesNotMatch(h.dialogs[0].title, /Recommended/);
});

test("the same command typed by the user carries no warning", async () => {
  const command = "git push --force origin release";
  const h = harness({
    choices: [DENY],
    branch: [
      said(`please run ${command}`),
      ...fetched("1", "read", { path: "NOTES.md" }, `Then run ${command}.`),
    ],
  });
  await h.run("bash", { command });
  assert.doesNotMatch(h.dialogs[0].title, /word for word/);
});

test("a copied command that is not risky is left alone", async () => {
  const h = harness({
    branch: [
      said("check the repo"),
      ...fetched("1", "read", { path: "NOTES.md" }, "Try git status --short to see changes."),
    ],
  });
  assert.equal(await h.run("bash", { command: "git status --short" }), undefined);
  assert.equal(h.dialogs.length, 0);
});

test("a judge that finds a copied command harmless still asks", async () => {
  const command = "rm src/app.ts";
  const { modelRegistry } = harmlessClassifier();
  const h = harness({
    modelRegistry,
    choices: [DENY],
    branch: [
      said("fix the app"),
      ...fetched("1", "web_fetch", { url: "https://example.com/fix" }, `cleanup: ${command}`),
    ],
  });
  const result = await h.run("bash", { command });
  assert.equal(result.block, true);
  assert.equal(h.dialogs.length, 1);
  assert.match(h.dialogs[0].title, /word for word in the output of web_fetch/);
});

test("with no one to ask, a copied command is refused", async () => {
  const command = "git push --force origin release";
  const h = harness({
    hasUI: false,
    branch: [said("tidy"), ...fetched("1", "read", { path: "a.md" }, `run ${command}`)],
  });
  const result = await h.run("bash", { command });
  assert.equal(result.block, true);
  assert.match(result.reason, /word for word in the output of read a.md/);
});

test("the judge weighs the last real request, not the yes after it", async () => {
  const { calls, modelRegistry } = harmlessClassifier();
  const h = harness({
    modelRegistry,
    branch: [said("clear out the old build files"), said("yes")],
  });
  await h.run("bash", { command: "rm src/app.ts" });
  assert.equal(calls[0].state.user_request, "clear out the old build files");
});

test("one yes covers one step: a different risky command asks again", async () => {
  const h = harness({ choices: [APPROVE, DENY] });
  assert.equal(await h.run("bash", { command: "git push origin feature" }), undefined);
  assert.equal(await h.run("bash", { command: "git push origin feature" }), undefined);
  assert.equal(h.dialogs.length, 1);
  const next = await h.run("bash", { command: "git push --force origin feature" });
  assert.equal(next.block, true);
  assert.equal(h.dialogs.length, 2);
});
