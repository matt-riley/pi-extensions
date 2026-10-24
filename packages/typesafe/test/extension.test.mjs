// The tool wiring: registration, and the refusals that must happen before any
// network call (so no key or fetch is needed here).

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

import typesafe from "../index.ts";

function load() {
  const tools = {};
  typesafe({
    registerTool: (def) => (tools[def.name] = def),
    exec: async () => ({ code: 1, stdout: "", stderr: "" }),
  });
  return tools;
}
const ctx = { cwd: process.cwd() };
const q = { a: { type: "noul", instructions: "?" } };
const run = (tools, params, extraCtx = {}) =>
  tools.typesafe_ask.execute("id", params, undefined, undefined, { ...ctx, ...extraCtx });

test("both tools register", () => {
  assert.deepEqual(Object.keys(load()).sort(), ["read_relevant", "typesafe_ask"]);
});

test("typesafe_ask needs state, paths or command", async () => {
  const result = await run(load(), { questions: q });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /Provide state, paths, or command/);
});

test("a mutating or secret-reading command is refused before anything runs", async () => {
  const tools = load();
  for (const command of ["rm -rf /tmp/x", "cat ~/.ssh/id_rsa"]) {
    const result = await run(tools, { command, questions: q });
    assert.equal(result.isError, true, command);
    assert.match(result.content[0].text, /command refused/);
  }
});

test("rank_by must name a noul or score question", async () => {
  const choice = { c: { type: "choice", instructions: "?", criteria: { x: null, y: null } } };
  const result = await run(load(), { paths: ["README.md"], rank_by: "c", questions: choice });
  assert.match(result.content[0].text, /rank_by must name a noul or score question/);
});

test("paths that resolve to nothing report why instead of calling Jev", async () => {
  const result = await run(load(), { paths: [".env", "../elsewhere"], questions: q });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /\.env: skipped: looks like a secret/);
  assert.match(result.content[0].text, /elsewhere: skipped: outside the repository/);
});

test("typesafe_ask uses Pi classify and returns the noul reading", async () => {
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
    async classify() {
      calls.push("classify");
      return {
        stopReason: "stop",
        answers: { a: { type: "bool", probability: 0.91 } },
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
  const previous = {
    TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
    TYPESAFE_BASE_URL: process.env.TYPESAFE_BASE_URL,
    TYPESAFE_TIMEOUT_MS: process.env.TYPESAFE_TIMEOUT_MS,
    LORE_CONFIG: process.env.LORE_CONFIG,
  };
  process.env.TYPESAFE_API_KEY = "typesafe-test-key";
  process.env.TYPESAFE_BASE_URL = "http://127.0.0.1:9/v1";
  process.env.TYPESAFE_TIMEOUT_MS = "200";
  process.env.LORE_CONFIG = join(tmpdir(), "typesafe-test-no-such-config.json");
  try {
    const result = await run(load(), { state: { note: "hi" }, questions: q }, { modelRegistry });
    assert.equal(calls.length, 1, "typesafe_ask did not call classify");
    assert.match(result.content[0].text, /noul 0\.91/);
    assert.doesNotMatch(result.content[0].text, /bool/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("typesafe_ask attaches classify usage so the session can count it", async () => {
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
    async classify() {
      calls.push("classify");
      return {
        stopReason: "stop",
        answers: { a: { type: "bool", probability: 0.91 } },
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
  const previous = {
    TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
    TYPESAFE_BASE_URL: process.env.TYPESAFE_BASE_URL,
    TYPESAFE_TIMEOUT_MS: process.env.TYPESAFE_TIMEOUT_MS,
    LORE_CONFIG: process.env.LORE_CONFIG,
  };
  process.env.TYPESAFE_API_KEY = "typesafe-test-key";
  process.env.TYPESAFE_BASE_URL = "http://127.0.0.1:9/v1";
  process.env.TYPESAFE_TIMEOUT_MS = "200";
  process.env.LORE_CONFIG = join(tmpdir(), "typesafe-test-no-such-config.json");
  try {
    const result = await run(load(), { state: { note: "hi" }, questions: q }, { modelRegistry });
    assert.equal(calls.length, 1, "typesafe_ask did not call classify");
    assert.equal(result.usage.input, 3);
    assert.equal(result.usage.output, 1);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("read_relevant refuses a secret path", async () => {
  const result = await load().read_relevant.execute(
    "id",
    { path: ".env", goal: "g" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /looks like a secret/);
});
