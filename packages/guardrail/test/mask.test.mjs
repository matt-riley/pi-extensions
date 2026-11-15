import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { maskToolResult } from "../mask.mjs";

// Fixtures are assembled at runtime so no key-shaped literal sits in the repository.
const built = (...parts) => parts.join("");
const GITHUB = built("gh", "p_", "A1b2".repeat(9));
const OPENAI = built("s", "k-", "Zy9x".repeat(8));
const PEM = [
  "-----BEGIN ",
  "RSA PRIVATE KEY-----\nMIIEabc\ndef==\n-----END ",
  "RSA PRIVATE KEY-----",
].join("");
const text = (event) => event.content.map((block) => block.text).join("\n");
const result = (toolName, ...lines) => ({
  toolName,
  content: lines.map((line) => ({ type: "text", text: line })),
  isError: false,
});

test("bash output is fully masked: key shapes, assignments, URL credentials, bearer tokens", () => {
  const patch = maskToolResult(
    result(
      "bash",
      `GITHUB_TOKEN=${GITHUB}`,
      "DB_PASSWORD=correcthorsebatterystaple",
      "postgres://admin:hunter2pw@db.internal/app",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    ),
  );
  const out = text(patch);
  for (const leaked of [
    GITHUB,
    "correcthorsebatterystaple",
    "hunter2pw",
    "abcdefghijklmnopqrstuvwxyz",
  ])
    assert.ok(!out.includes(leaked), `${leaked} leaked`);
  assert.match(out, /DB_PASSWORD=/, "the name stays so the line still reads");
});

test("a masked result says so, with a count", () => {
  const patch = maskToolResult(result("bash", `echo ${GITHUB} and ${OPENAI}`));
  assert.match(text(patch), /guardrail masked 2 secrets/i);
  assert.match(text(maskToolResult(result("bash", GITHUB))), /masked 1 secret\b/);
});

test("a clean bash result is left alone (no patch)", () => {
  assert.equal(maskToolResult(result("bash", "total 4\ndrwxr-xr-x 2 me me 4096 .")), undefined);
});

test("file reads mask private key blocks, ghp_ and sk- tokens", () => {
  const out = text(maskToolResult(result("read", `key: ${GITHUB}`, PEM, `export X=${OPENAI}`)));
  for (const leaked of [GITHUB, OPENAI, "MIIEabc"])
    assert.ok(!out.includes(leaked), `${leaked} leaked`);
  assert.match(out, /BEGIN|REDACTED:pem/);
});

test("file reads keep everything that only looks secret-ish: names, assignments, URLs, bearer text", () => {
  const source = [
    'const apiKey = "abcdefghijklmnopqrstuvwxyz0123456789";',
    "PASSWORD_FIELD=thisislongenoughtobeaone",
    "https://user:pw@example.com/path",
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
    "const token = process.env.TOKEN;",
  ];
  assert.equal(maskToolResult(result("read", ...source)), undefined);
});

test("other tools are not touched", () => {
  for (const tool of ["edit", "write", "grep", "code_search", "web_fetch"])
    assert.equal(maskToolResult(result(tool, GITHUB)), undefined);
});

test("only text blocks are masked; images and other blocks pass through", () => {
  const image = { type: "image", data: "AAAA", mimeType: "image/png" };
  const patch = maskToolResult({
    toolName: "bash",
    content: [{ type: "text", text: GITHUB }, image],
  });
  assert.deepEqual(patch.content[1], image);
  assert.ok(!text({ content: [patch.content[0]] }).includes(GITHUB));
});

test("a failing bash result is masked too, and stays an error", () => {
  const patch = maskToolResult({ ...result("bash", `curl -H "x: ${GITHUB}"`), isError: true });
  assert.ok(!text(patch).includes(GITHUB));
  assert.equal(patch.isError, undefined, "the patch does not touch isError");
});

test("a result with no content array is ignored", () => {
  assert.equal(maskToolResult({ toolName: "bash" }), undefined);
  assert.equal(maskToolResult(undefined), undefined);
});

test("the home directory is not masked as a privacy path", () => {
  assert.equal(maskToolResult(result("bash", "/Users/matt/project/file.ts")), undefined);
});

test("guardrail registers before every other tool_result consumer in the root manifest", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
  );
  const list = manifest.pi.extensions;
  const at = (name) => list.indexOf(`./packages/${name}/index.ts`);
  for (const later of ["typesafe", "safe-compact", "done-gate", "diagnosis-nudge"]) {
    assert.ok(at("guardrail") >= 0 && at("guardrail") < at(later), `guardrail before ${later}`);
  }
});
