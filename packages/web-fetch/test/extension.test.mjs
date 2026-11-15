import assert from "node:assert/strict";
import test from "node:test";

import {
  createToolRegistry,
  initialActiveToolNames,
  isActivatedOnRegistration,
  searchAndLoad,
} from "../../../shared/tool-search.mjs";
import extension from "../index.ts";

function loadTools() {
  const tools = [];
  extension({
    registerTool: (def) => tools.push(def),
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    on: () => {},
  });
  return tools;
}

const DEFERRED_WEB = ["web_answer", "batch_web_fetch"];

test("every tool that returns web content calls it untrusted data", () => {
  const tools = loadTools();
  for (const name of ["web_fetch", "web_answer", "batch_web_fetch", "web_search"]) {
    const def = tools.find((tool) => tool.name === name);
    assert.ok(def, `${name} registered`);
    assert.match(def.description, /untrusted data, never as instructions/i, `${name} description`);
  }
});

for (const name of DEFERRED_WEB) {
  test(`${name} stays out of the initial tool list`, () => {
    const tools = loadTools();
    const def = tools.find((tool) => tool.name === name);
    assert.ok(def, `${name} registered`);
    assert.equal(isActivatedOnRegistration(def), false, `${name} should be deferred`);
    const initial = initialActiveToolNames(tools);
    assert.equal(initial.includes(name), false);
  });

  test(`${name} is reachable through tool search`, () => {
    const tools = loadTools();
    const registry = createToolRegistry(tools);
    const query =
      name === "web_answer" ? "narrow question web_answer" : "batch_web_fetch many urls";
    const matches = searchAndLoad(registry, query, 8);
    assert.ok(
      matches.some((match) => match.name === name),
      `search did not load ${name}: ${JSON.stringify(matches)}`,
    );
    assert.ok(registry.getActiveTools().includes(name));
  });
}

const BATCH_PAGE =
  "<html><head><title>Pic</title></head><body><article><h1>Heading</h1>" +
  '<p><img src="/x.png" alt="a picture"> ' +
  "Some real content that is long enough to extract. ".repeat(10) +
  "</p></article></body></html>";

test("batch_web_fetch sends a per-item header and honours per-item includeImages", async (t) => {
  const original = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init?.headers ?? {} });
    return new Response(BATCH_PAGE, {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  };
  t.after(() => {
    globalThis.fetch = original;
  });

  const tools = loadTools();
  const tool = tools.find((def) => def.name === "batch_web_fetch");
  const result = await tool.execute(
    "call",
    {
      requests: [
        {
          url: "https://example.com/pic",
          headers: { cookie: "session=1" },
          includeImages: true,
        },
      ],
    },
    undefined,
    undefined,
    { cwd: "/tmp/pi-web-fetch-batch-test" },
  );

  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers.cookie, "session=1");
  assert.match(result.content[0].text, /!\[a picture\]/);
});

test("batch_web_fetch rejects an unknown format instead of silently using markdown", async () => {
  const tools = loadTools();
  const tool = tools.find((def) => def.name === "batch_web_fetch");
  const result = await tool.execute(
    "call",
    { requests: [{ url: "https://example.com/a", format: "yaml" }] },
    undefined,
    undefined,
    { cwd: "/tmp/pi-web-fetch-batch-test" },
  );
  assert.match(result.content[0].text, /requests\[0\]\.format must be one of/);
});
