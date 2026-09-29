// The tool wiring: registration, and the refusals that must happen before any
// network call (so no key or fetch is needed here).

import { test } from "node:test";
import assert from "node:assert/strict";

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
const run = (tools, params) => tools.typesafe_ask.execute("id", params, undefined, undefined, ctx);

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
