// runChild against a scripted stand-in for the host SDK, so the lifecycle —
// completion, timeout, abort, error, turn budget and child env — is covered
// without starting a real session.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

import { CHILD_ENV } from "../child-env.mjs";

const SDK = "@earendil-works/pi-coding-agent";
const SDK_FAKE = `data:text/javascript,${encodeURIComponent(`
export const getAgentDir = () => "/nonexistent-agent-dir";
export class SessionManager { static inMemory() { return {}; } }
export class DefaultResourceLoader {
  constructor(options) { globalThis.__sdk.loaderOptions = options; }
  async reload() { globalThis.__sdk.envDuringLoad = process.env.PI_SUBAGENT_CHILD; }
}
export const createAgentSession = async (options) => {
  globalThis.__sdk.sessionOptions = options;
  return { session: globalThis.__sdk.makeSession() };
};
`)}`;

let hooks;
let runChild;
let cwd;
const originalChildEnv = process.env[CHILD_ENV];
before(async () => {
  hooks = registerHooks({
    resolve: (specifier, context, next) =>
      specifier === SDK ? { url: SDK_FAKE, shortCircuit: true } : next(specifier, context),
  });
  ({ runChild } = await import("../spawn.mjs"));
  cwd = await mkdtemp(path.join(tmpdir(), "spawn-test-"));
});
after(async () => {
  hooks.deregister();
  await rm(cwd, { recursive: true, force: true });
});

const assistant = (text, usage = { input: 10, output: 5, totalTokens: 15 }) => ({
  role: "assistant",
  content: [{ type: "text", text }],
  usage,
});

/** A session whose prompt() runs `script(session)`; steer/abort calls are recorded. */
function install(script, { onAbort } = {}) {
  const sdk = (globalThis.__sdk = { steers: [], aborts: 0, disposed: 0 });
  sdk.makeSession = () => {
    const listeners = new Set();
    const session = {
      messages: [],
      emit: (event) => listeners.forEach((listener) => listener(event)),
      subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
      steer: async (text) => void sdk.steers.push(text),
      abort: async () => {
        sdk.aborts++;
        onAbort?.(session);
      },
      dispose: () => void sdk.disposed++,
      prompt: (task) => script(session, task),
    };
    return session;
  };
  return sdk;
}

const agent = { name: "scout", systemPrompt: "Look around." };
const turn = (session, text) => {
  session.messages.push(assistant(text));
  session.emit({ type: "message_end", message: session.messages.at(-1) });
  session.emit({ type: "turn_end" });
};

test("a finished child reports its last answer, usage and turn count", async () => {
  const sdk = install(async (session, task) => {
    assert.equal(task, "find it");
    session.emit({ type: "tool_execution_start", toolName: "read", args: { path: "a.ts" } });
    turn(session, "found it");
  });
  const events = [];
  const result = await runChild({
    cwd,
    agent,
    task: "find it",
    maxTurns: 10,
    onEvent: (e) => events.push(e),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.text, "found it");
  assert.equal(result.turns, 1);
  assert.equal(result.toolUses, 1);
  assert.equal(result.tokens, 15);
  assert.equal(sdk.disposed, 1);
  assert.ok(events.some((e) => e.turns === 1));
});

test("the child sees PI_SUBAGENT_CHILD only while its extensions load", async () => {
  const sdk = install((session) => turn(session, "ok"));
  await runChild({ cwd, agent, task: "t", maxTurns: 5 });
  assert.equal(sdk.envDuringLoad, "1");
  assert.equal(process.env[CHILD_ENV], originalChildEnv);
});

test("a read-only agent gets the bash allowlist and blocked writers; a writer does not", async () => {
  const sdk = install((session) => turn(session, "ok"));
  await runChild({ cwd, agent, task: "t", maxTurns: 5 });
  assert.ok(sdk.sessionOptions.tools.length > 0);
  assert.deepEqual(sdk.sessionOptions.excludeTools, ["subagent"]);
  assert.equal(sdk.loaderOptions.extensionFactories.length, 1);

  const worker = { name: "worker", systemPrompt: "", toolsListed: true, tools: ["read", "edit"] };
  install((session) => turn(session, "ok"));
  await runChild({ cwd, agent: worker, task: "t", maxTurns: 5 });
  assert.deepEqual(globalThis.__sdk.sessionOptions.tools, ["read", "edit"]);
  assert.match(globalThis.__sdk.loaderOptions.systemPromptOverride(), /write-capable/);
});

test("a prompt that throws becomes an error result, not a rejection", async () => {
  install(() => {
    throw new Error("provider down");
  });
  const result = await runChild({ cwd, agent, task: "t", maxTurns: 5 });
  assert.equal(result.status, "error");
  assert.equal(result.error, "provider down");
  assert.equal(globalThis.__sdk.disposed, 1);
});

test("a child that outlives its timeout is aborted and reported as timed out", async () => {
  const sdk = install(() => new Promise(() => {}), {
    onAbort: () => {},
  });
  // prompt never settles on its own; abort() releases it in the real SDK, so
  // the stand-in resolves on abort.
  const release = [];
  sdk.makeSession = ((make) => () => {
    const session = make();
    session.prompt = () => new Promise((done) => release.push(done));
    const abort = session.abort;
    session.abort = async () => (await abort(), release.forEach((done) => done()));
    return session;
  })(sdk.makeSession);
  const result = await runChild({ cwd, agent, task: "t", maxTurns: 5, timeoutMs: 20 });
  assert.equal(result.status, "timed out");
  assert.equal(sdk.aborts, 1);
});

test("an abort signal stops the child, and an already-aborted signal never prompts", async () => {
  const controller = new AbortController();
  const sdk = install(
    (session) =>
      new Promise((done) => {
        session.abort = async () => (sdk.aborts++, done());
        controller.abort();
      }),
  );
  const result = await runChild({ cwd, agent, task: "t", maxTurns: 5, signal: controller.signal });
  assert.equal(result.status, "stopped");

  let prompted = false;
  install(() => void (prompted = true));
  const already = new AbortController();
  already.abort();
  const second = await runChild({ cwd, agent, task: "t", maxTurns: 5, signal: already.signal });
  assert.equal(second.status, "stopped");
  assert.equal(prompted, false);
});

test("the turn budget warns, asks for a wrap-up, then aborts a child that ignores it", async () => {
  const sdk = install(async (session) => {
    for (let i = 0; i < 30 && sdk.aborts === 0; i++) turn(session, `step ${i}`);
  });
  const result = await runChild({ cwd, agent, task: "t", maxTurns: 10 });
  assert.equal(sdk.steers.length, 2);
  assert.match(sdk.steers[0], /turns? left/);
  assert.match(sdk.steers[1], /Wrap up immediately/);
  assert.equal(result.status, "aborted");
  assert.match(result.text, /step/); // the partial report keeps what was learned
});

test("a child that wraps up when asked finishes as wrapped up", async () => {
  const sdk = install(async (session) => {
    for (let i = 0; i < 11; i++) turn(session, i === 10 ? "final answer" : `step ${i}`);
  });
  const result = await runChild({ cwd, agent, task: "t", maxTurns: 10 });
  assert.equal(sdk.steers.at(-1), "Wrap up immediately — provide your final answer now.");
  assert.equal(result.status, "wrapped up");
  assert.equal(result.text, "final answer");
});

test("the transcript is written one message per line when a run file is given", async () => {
  install((session) => turn(session, "saved"));
  const runFile = path.join(cwd, "runs", "a.jsonl");
  await runChild({ cwd, agent, task: "t", maxTurns: 5, runFile });
  const lines = (await readFile(runFile, "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(lines.at(-1).content[0].text, "saved");
});
