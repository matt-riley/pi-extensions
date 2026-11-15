import { test } from "node:test";
import assert from "node:assert/strict";

import { dependencyConfirmation, dependencyEditPath } from "../deps.mjs";

test("a bash install gives a plain reason and a scope per manager and package", () => {
  const found = dependencyConfirmation({
    toolName: "bash",
    input: { command: "cd app && pnpm add zod @scope/x@1" },
  });
  assert.equal(found.reason, "pnpm add would add dependencies: zod, @scope/x@1");
  assert.deepEqual(found.scopes, ["dependency:pnpm:zod", "dependency:pnpm:@scope/x@1"]);
});

test("a plain install gives nothing", () => {
  assert.equal(dependencyConfirmation({ toolName: "bash", input: { command: "npm ci" } }), null);
  assert.equal(
    dependencyConfirmation({ toolName: "bash", input: { command: "npm install" } }),
    null,
  );
});

test("a file edit names what it adds and what version it changes", () => {
  const before = '{\n  "dependencies": { "zod": "^3.0.0" }\n}\n';
  const content = '{\n  "dependencies": { "zod": "^4.0.0", "left-pad": "^1.3.0" }\n}\n';
  const found = dependencyConfirmation({
    toolName: "write",
    input: { path: "/r/package.json", content },
    before,
  });
  assert.equal(
    found.reason,
    "write would change dependencies in package.json: zod ^3.0.0 → ^4.0.0 (dependencies), left-pad ^1.3.0 (dependencies)",
  );
  assert.deepEqual(found.scopes, [
    "dependency:package.json:dependencies:zod",
    "dependency:package.json:dependencies:left-pad",
  ]);
});

test("a long list is cut to five names and a count", () => {
  const list = Array.from({ length: 8 }, (_, n) => `p${n}`).join(" ");
  const found = dependencyConfirmation({ toolName: "bash", input: { command: `npm i ${list}` } });
  assert.equal(found.reason, "npm install would add dependencies: p0, p1, p2, p3, p4 and 3 more");
  assert.equal(found.scopes.length, 8);
});

test("other tools and unrelated calls give nothing", () => {
  assert.equal(dependencyConfirmation({ toolName: "read", input: { path: "package.json" } }), null);
  assert.equal(dependencyConfirmation({ toolName: "bash", input: { command: "ls" } }), null);
  assert.equal(dependencyConfirmation({ toolName: "bash", input: {} }), null);
  assert.equal(dependencyConfirmation({}), null);
});

test("only edit and write of package.json or go.mod name a file to read first", () => {
  assert.equal(dependencyEditPath("edit", { path: "a/package.json" }), "a/package.json");
  assert.equal(dependencyEditPath("Write", { path: "go.mod" }), "go.mod");
  assert.equal(dependencyEditPath("read", { path: "package.json" }), null);
  assert.equal(dependencyEditPath("edit", { path: "src/index.ts" }), null);
  assert.equal(dependencyEditPath("edit", {}), null);
  assert.equal(dependencyEditPath("bash", { command: "echo > package.json" }), null);
});
