import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkConventions, runtimeImports } from "./check-conventions.mjs";

test("runtime imports distinguish erased types, mixed bindings, empty imports and dynamic imports", () => {
  const found = runtimeImports(
    `
import type { Foo } from "types-only";
import { type Bar } from "also-types";
import { type Foo, getAgentDir as dir } from "sdk";
import {} from "empty-import";
export {} from "empty-export";
export type { Baz } from "exported-types";
export { value } from "exported-runtime";
import("dynamic"); require("required"); import(variable);
`,
    "fixture.ts",
  );
  assert.deepEqual(
    found.map((item) => item.specifier),
    ["sdk", "empty-import", "empty-export", "exported-runtime", "dynamic", "required", null],
  );
  assert.deepEqual(found[0].names, ["getAgentDir"]);
});

test("conventions catch missing/duplicate registration, metadata, dependencies and runtime imports", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-conventions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "packages", "sample"), { recursive: true });
  const write = (name, data) =>
    writeFileSync(path.join(root, name), typeof data === "string" ? data : JSON.stringify(data));
  write("package.json", { pi: { extensions: ["./packages/sample/index.ts"] } });
  write("packages/sample/package.json", { name: "sample", description: "fixture", version: "1" });
  write("packages/sample/README.md", "fixture");
  write(
    "packages/sample/index.ts",
    'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"; import { Type } from "typebox";',
  );
  assert.deepEqual(checkConventions(root), []);
  write("package.json", {
    pi: { extensions: ["./packages/missing/index.ts", "./packages/missing/index.ts"] },
    dependencies: { foo: "1" },
  });
  write("packages/sample/package.json", {
    name: "sample",
    pi: {},
    optionalDependencies: { bad: "1" },
  });
  write(
    "packages/sample/index.ts",
    'import { getAgentDir } from "@earendil-works/pi-coding-agent"; import("external");',
  );
  const errors = checkConventions(root).join("\n");
  for (const expected of [
    "duplicate",
    "Unknown extension",
    "missing root registration",
    "missing description",
    "per-package pi",
    "dependencies",
    "optionalDependencies",
    "unapproved runtime import",
  ])
    assert.ok(errors.includes(expected), expected);
});
