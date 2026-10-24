import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../index.ts";
const bashResult = (output, overrides = {}) => ({
  isError: false,
  result: { structuredContent: { output, exit_code: 0, truncated: false, ...overrides } },
});

const triage = process.env.PI_DIAGNOSIS_TRIAGE;
process.env.PI_DIAGNOSIS_TRIAGE = "off";
test.after(() => {
  if (triage === undefined) delete process.env.PI_DIAGNOSIS_TRIAGE;
  else process.env.PI_DIAGNOSIS_TRIAGE = triage;
});

async function harness(t, entries = []) {
  const cwd = mkdtempSync(join(tmpdir(), "diagnosis-gate-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  git("init", "-q");
  writeFileSync(join(cwd, "code.js"), "original");
  git("add", ".");
  git(
    "-c",
    "commit.gpgsign=false",
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "-qm",
    "test: base",
  );
  const handlers = {};
  const tools = {};
  const commands = {};
  const branch = [...entries];
  let nextId = 0;
  const ctx = {
    cwd,
    hasUI: false,
    sessionManager: { getBranch: () => branch },
    executeTool: async () => bashResult("observed premise"),
  };
  const pi = {
    on: (name, fn) => (handlers[name] ??= []).push(fn),
    registerTool: (def) => {
      tools[def.name] = def;
    },
    registerCommand: (name, def) => {
      commands[name] = def;
    },
    appendEntry: (customType, data) =>
      branch.push({ type: "custom", customType, data: structuredClone(data) }),
    getAllTools: () => [],
  };
  extension(pi);
  const dispatch = async (name, event = {}) => {
    let result;
    for (const handler of handlers[name] ?? []) {
      const value = await handler(event, ctx);
      if (value) result = value;
      if (value?.block) break;
    }
    return result;
  };
  await dispatch("session_start");
  return {
    cwd,
    ctx,
    tools,
    commands,
    branch,
    dispatch,
    reload: async () => {
      for (const name of Object.keys(handlers)) delete handlers[name];
      extension(pi);
      await dispatch("session_start");
    },
    write: (value) => writeFileSync(join(cwd, "code.js"), value),
    call: (toolName, input = {}) => dispatch("tool_call", { toolName, input }),
    check: async (failed = true, command = "npm test", during) => {
      const event = { toolName: "bash", toolCallId: String(++nextId), input: { command } };
      const blocked = await dispatch("tool_call", event);
      if (blocked?.block) return blocked;
      during?.();
      return dispatch("tool_result", { ...event, isError: failed, content: [] });
    },
    checkpoint: (params = {}, signal) =>
      tools.diagnosis_checkpoint.execute(
        "checkpoint",
        {
          premise: "Both failures assume that the parser receives a string.",
          command: "cat code.js",
          expected_observation: "The input shape either confirms or refutes that assumption.",
          ...params,
        },
        signal,
        undefined,
        ctx,
      ),
  };
}

async function arm(h) {
  h.write("first attempted fix");
  await h.check();
  h.write("second attempted fix");
  await h.check();
}

test("two failed revised checks block the next edit, not searches or same-tree retries", async (t) => {
  const h = await harness(t);
  await h.check();
  await h.check();
  assert.equal(await h.call("edit"), undefined);
  h.write("first attempted fix");
  await h.check();
  await h.check();
  assert.equal(await h.call("edit"), undefined);
  h.write("second attempted fix");
  await h.check();
  assert.equal((await h.call("edit")).block, true);
  assert.equal((await h.call("write")).block, true);
  assert.equal((await h.call("bash", { command: "touch bypass" })).block, true);
  assert.equal((await h.call("unknown_writer")).block, true);
  assert.equal(await h.call("bash", { command: "cat code.js" }), undefined);
  assert.equal(await h.call("read"), undefined);
  assert.equal(await h.call("codemode"), undefined, "nested calls are gated separately");
  assert.equal(await h.call("tool_search"), undefined);
});

test("ordinary failures and masked checks do not become failed-fix evidence", async (t) => {
  const h = await harness(t);
  for (const command of [
    "grep absent code.js",
    "false && npm test",
    "npm test || true",
    "npm test > report",
  ]) {
    h.write(command + " first");
    await h.check(true, command);
    h.write(command + " second");
    await h.check(true, command);
  }
  assert.equal(await h.call("edit"), undefined);
});

test("a passing exact check clears its failed attempts; unrelated success and input do not", async (t) => {
  const h = await harness(t);
  await arm(h);
  await h.check(false, "grep present code.js");
  await h.dispatch("tool_result", { toolName: "typesafe_ask", isError: false });
  await h.dispatch("input");
  assert.equal((await h.call("edit")).block, true);
  assert.equal(await h.call("bash", { command: "npm test" }), undefined);
  await h.check(false);
  assert.equal(await h.call("edit"), undefined);
});

test("a real observation releases the gate and carries revision-bound evidence", async (t) => {
  const h = await harness(t);
  await arm(h);
  let calls = 0;
  h.ctx.executeTool = async (name, input) => {
    calls++;
    assert.equal(name, "bash");
    assert.equal(input.command, "cat code.js");
    assert.equal(await h.call(name, input), undefined);
    return bashResult("second attempted fix");
  };
  const result = await h.checkpoint();
  assert.equal(calls, 1);
  assert.equal(result.details.observation, "second attempted fix");
  assert.match(result.details.revision.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(await h.call("edit"), undefined);
  await assert.rejects(h.checkpoint(), /No failed-fix checkpoint/);
  await arm(h);
  assert.equal((await h.call("edit")).block, true, "two new fixes re-arm the gate");
});

test("invalid, empty, failed, cancelled and stale checkpoints cannot release it", async (t) => {
  const h = await harness(t);
  await arm(h);
  for (const params of [
    { premise: " " },
    { expected_observation: "" },
    { command: "touch bypass" },
    { command: "npm test" },
    { command: "cat code.js > bypass" },
  ])
    await assert.rejects(h.checkpoint(params), /Supply/);
  for (const result of [
    bashResult("Permission denied", { exit_code: 1 }),
    { ...bashResult("host blocked"), isError: true },
    { ...bashResult("unknown host status"), isError: undefined },
    bashResult(""),
    bashResult("incomplete observation", { truncated: true }),
    { content: [{ type: "text", text: "unstructured unknown status" }] },
  ]) {
    h.ctx.executeTool = async () => result;
    await assert.rejects(h.checkpoint(), /Checkpoint failed/);
    assert.equal((await h.call("edit")).block, true);
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(h.checkpoint({}, controller.signal), /abort/i);
  h.ctx.executeTool = async () => {
    h.write("concurrent outside change");
    return bashResult("an observation");
  };
  await assert.rejects(h.checkpoint(), /changed revision/);
  assert.equal((await h.call("edit")).block, true);
});

test("cancellation during final revision validation cannot release a checkpoint", async (t) => {
  const h = await harness(t);
  await arm(h);
  const controller = new AbortController();
  h.ctx.executeTool = async () => {
    setImmediate(() => controller.abort());
    return bashResult("observation");
  };
  await assert.rejects(h.checkpoint({}, controller.signal), /abort/i);
  assert.equal((await h.call("edit")).block, true);
});

test("checkpoint survives reload, session switching and tree navigation; reset is human-owned", async (t) => {
  const h = await harness(t);
  const initial = h.branch.length;
  await arm(h);
  await h.reload();
  assert.equal((await h.call("edit")).block, true);
  await h.dispatch("session_start", { reason: "resume" });
  assert.equal((await h.call("edit")).block, true);
  await h.commands.diagnosis.handler("reset", h.ctx);
  assert.equal(await h.call("edit"), undefined);
  h.branch.splice(initial);
  await h.dispatch("session_tree");
  assert.equal(await h.call("edit"), undefined, "abandoned branch evidence must not leak");
});

test("tree-changing and unknown host checks never count as known failed fixes", async (t) => {
  const h = await harness(t);
  h.write("before one");
  await h.check(true, "npm test", () => h.write("after one"));
  h.write("before two");
  await h.check(true, "npm test", () => h.write("after two"));
  assert.equal(await h.call("edit"), undefined);
});

test("concurrent checkpoints cannot both run, and navigation invalidates an in-flight observation", async (t) => {
  const h = await harness(t);
  await arm(h);
  let finish;
  let entered;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  h.ctx.executeTool = () =>
    new Promise((resolve) => {
      finish = resolve;
      entered();
    });
  const first = h.checkpoint();
  const second = h.checkpoint();
  await assert.rejects(second, /already running/);
  await started;
  await h.dispatch("session_start", { reason: "resume" });
  finish(bashResult("observation on old session"));
  await assert.rejects(first, /changed revision\/session/);
  assert.equal((await h.call("edit")).block, true);
});
