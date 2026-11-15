// End to end: a fake pi drives the real tool_result handler, and a local HTTP
// server stands in for TypeSafe, so the hook, the pattern check, the request
// and the routing are exercised together without spending a token.

import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import piDeslopExtension from "../index.ts";

const SLOP = "It's worth noting that this is a seamless upgrade.";
const PLAIN = "The upgrade keeps your config and takes one command.";
const noul = (value) => ({ type: "noul", noul: value });

const ENV_KEYS = [
  "TYPESAFE_API_KEY",
  "LORE_TYPESAFE_API_KEY",
  "TYPESAFE_BASE_URL",
  "LORE_CONFIG",
  "PI_DESLOP",
  "PI_DESLOP_VERIFY",
];
const ENV_BACKUP = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const requests = [];
let answers = {};
let status = 200;
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    requests.push(JSON.parse(body));
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ model: "jev-1.13.0", answers, usage: null }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

after(() => {
  server.close();
  for (const [key, value] of Object.entries(ENV_BACKUP)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

beforeEach(() => {
  requests.length = 0;
  answers = {};
  status = 200;
  process.env.TYPESAFE_API_KEY = "deslop-test-key";
  process.env.TYPESAFE_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
  process.env.LORE_CONFIG = join(tmpdir(), "deslop-test-no-such-config.json");
  delete process.env.LORE_TYPESAFE_API_KEY;
  delete process.env.PI_DESLOP;
  delete process.env.PI_DESLOP_VERIFY;
});

function harness() {
  const handlers = {};
  const commands = {};
  const messages = [];
  const notices = [];
  piDeslopExtension({
    registerCommand: (name, command) => {
      commands[name] = command;
    },
    sendUserMessage: (...args) => {
      messages.push(args);
    },
    on: (name, handler) => {
      handlers[name] = handler;
    },
  });
  const ctx = { cwd: "/repo", ui: { notify: (...args) => notices.push(args) } };
  const result = (toolName, input, extra = {}) =>
    handlers.tool_result(
      { toolName, input, isError: false, content: [{ type: "text", text: "ok" }], ...extra },
      ctx,
    );
  return {
    handlers,
    commands,
    messages,
    notices,
    deslop: (args) => commands.deslop.handler(args, ctx),
    write: (path, content, extra) => result("write", { path, content }, extra),
    edit: (path, oldText, newText) => result("edit", { path, edits: [{ oldText, newText }] }),
    input: () => handlers.input({}, ctx),
  };
}

const noteOf = (patched) => patched?.content?.at(-1)?.text;

test("the extension registers the post-edit hook and its two resets", () => {
  const { handlers } = harness();
  assert.deepEqual(Object.keys(handlers).sort(), ["input", "session_start", "tool_result"]);
});

test("a sloppy write is verified with TypeSafe and the note rides on the tool result", async () => {
  const pi = harness();
  answers = { worse_for_reader: noul(0.91), discusses_patterns: noul(0.03) };
  const patched = await pi.write("README.md", SLOP);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].state.path, "README.md");
  assert.equal(requests[0].state.text, SLOP);
  assert.deepEqual(Object.keys(requests[0].questions).sort(), [
    "discusses_patterns",
    "worse_for_reader",
  ]);
  assert.equal(patched.content.length, 2);
  assert.deepEqual(patched.content[0], { type: "text", text: "ok" });
  assert.match(noteOf(patched), /^deslop: the text this edit added to README\.md/);
  assert.match(noteOf(patched), /worse_for_reader 0\.91/);
});

test("clean prose and code edits pass through untouched with no request", async () => {
  const pi = harness();
  assert.equal(await pi.write("README.md", PLAIN), undefined);
  assert.equal(await pi.write("src/index.ts", `// ${SLOP}`), undefined);
  assert.equal(requests.length, 0);
});

test("findings TypeSafe reads as a catalogue of patterns are not reported", async () => {
  const pi = harness();
  answers = { worse_for_reader: noul(0.9), discusses_patterns: noul(0.85) };
  assert.equal(await pi.write("docs/style.md", `Avoid phrases like: ${SLOP}`), undefined);
  assert.equal(requests.length, 1);
});

test("the rewrite is verified: same meaning and clean is silent", async () => {
  const pi = harness();
  answers = { worse_for_reader: noul(0.9), discusses_patterns: noul(0.02) };
  await pi.write("README.md", SLOP);
  answers = { meaning_preserved: noul(0.93), still_formulaic: noul(0.1) };
  const patched = await pi.edit("README.md", SLOP, PLAIN);

  assert.equal(patched, undefined);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].state, { path: "README.md", before: SLOP, after: PLAIN });
  assert.deepEqual(Object.keys(requests[1].questions).sort(), [
    "meaning_preserved",
    "still_formulaic",
  ]);
});

test("the rewrite is verified: a changed meaning is sent back to the agent", async () => {
  const pi = harness();
  answers = { worse_for_reader: noul(0.9), discusses_patterns: noul(0.02) };
  await pi.write("README.md", SLOP);
  answers = { meaning_preserved: noul(0.08), still_formulaic: noul(0.1) };
  const patched = await pi.edit("README.md", SLOP, "The upgrade is risky.");
  assert.match(noteOf(patched), /changing what the text says \(meaning_preserved 0\.08/);
});

test("a TypeSafe failure degrades to the pattern check and never throws", async () => {
  const pi = harness();
  status = 500;
  const patched = await pi.write("README.md", SLOP);
  assert.match(noteOf(patched), /TypeSafe was unavailable, so this is the pattern check alone/);
});

test("PI_DESLOP_VERIFY=0 sends nothing to TypeSafe", async () => {
  const pi = harness();
  process.env.PI_DESLOP_VERIFY = "0";
  const patched = await pi.write("README.md", SLOP);
  assert.match(noteOf(patched), /verification is switched off.*pattern check alone/);
  assert.equal(requests.length, 0);
});

test("PI_DESLOP=0 turns the extension off", async () => {
  const pi = harness();
  process.env.PI_DESLOP = "off";
  assert.equal(await pi.write("README.md", SLOP), undefined);
  assert.equal(requests.length, 0);
});

test("a new prompt forgets flagged files, so the next edit is a first pass", async () => {
  const pi = harness();
  answers = { worse_for_reader: noul(0.9), discusses_patterns: noul(0.02) };
  await pi.write("README.md", SLOP);
  await pi.input();
  await pi.edit("README.md", SLOP, PLAIN);
  assert.equal(requests.length, 1, "no rewrite judgment after the reset");
});

test("input and session_start each restore an exhausted note budget", async () => {
  const pi = harness();
  process.env.PI_DESLOP_VERIFY = "0";
  for (const reset of ["input", "session_start"]) {
    assert.ok(noteOf(await pi.write("README.md", SLOP)));
    assert.ok(noteOf(await pi.write("README.md", SLOP)));
    assert.equal(await pi.write("README.md", SLOP), undefined);
    await pi.handlers[reset]({}, { cwd: "/repo" });
  }
  assert.ok(noteOf(await pi.write("README.md", SLOP)));
  assert.equal(requests.length, 0);
});

test("a result without a content array is left alone", async () => {
  const pi = harness();
  answers = { worse_for_reader: noul(0.9), discusses_patterns: noul(0.02) };
  assert.equal(await pi.write("README.md", SLOP, { content: undefined }), undefined);
});

test("no key makes no request through the hook", async () => {
  delete process.env.TYPESAFE_API_KEY;
  const pi = harness();
  assert.match(noteOf(await pi.write("README.md", SLOP)), /TypeSafe was unavailable/);
  assert.equal(requests.length, 0);
});

test("credentials crossing the text cap are not sent as fragments", async () => {
  const pi = harness();
  const secret = "ghp_" + "B".repeat(36);
  const text = SLOP + " " + "x".repeat(5990 - SLOP.length - 1) + " " + secret;
  await pi.write("README.md", text);
  assert.equal(requests.length, 1);
  assert.doesNotMatch(JSON.stringify(requests[0].state), /ghp_B/);
  assert.ok(requests[0].state.text.length <= 6000);
});

test("credentials crossing the excerpt cap are not sent as fragments", async () => {
  const pi = harness();
  const text = "It's worth noting " + "x".repeat(112) + " ghp_" + "B".repeat(36) + ".";
  await pi.write("README.md", text);
  assert.equal(requests.length, 1);
  assert.doesNotMatch(JSON.stringify(requests[0].state), /ghp_B/);
});

test("/deslop forwards one file as a meaning-preserving rewrite task", async () => {
  const pi = harness();
  await pi.deslop("docs/existing file.md");
  assert.equal(pi.messages.length, 1);
  const [message, options] = pi.messages[0];
  assert.match(message, /"docs\/existing file.md"/);
  assert.match(message, /Read/);
  assert.match(message, /preserve/i);
  assert.match(message, /facts/);
  assert.deepEqual(options, { deliverAs: "followUp" });
  assert.equal(requests.length, 0);
});

test("/deslop with no file shows usage without starting a turn", async () => {
  const pi = harness();
  await pi.deslop("  ");
  assert.equal(pi.messages.length, 0);
  assert.deepEqual(pi.notices, [["Usage: /deslop <file>", "info"]]);
});

test("/deslop respects the extension off switch", async () => {
  const pi = harness();
  process.env.PI_DESLOP = "0";
  await pi.deslop("README.md");
  assert.equal(pi.messages.length, 0);
  assert.deepEqual(pi.notices, [["deslop is disabled (PI_DESLOP).", "info"]]);
});
