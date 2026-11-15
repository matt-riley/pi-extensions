import { test } from "node:test";
import assert from "node:assert/strict";

import { loadImportGraph } from "../../../shared/import-graph.mjs";

/** A repository as { path: text }: the graph sees the paths and reads the text. */
const repo = (tree) =>
  loadImportGraph({ files: Object.keys(tree), readFile: async (rel) => tree[rel] ?? null });

test("relative specifiers probe extensions and index files", async () => {
  const graph = await repo({
    "src/index.ts": "",
    "src/helper/index.ts": "",
    "src/util.mjs": "",
  });
  assert.deepEqual(graph.resolve("./helper", "src/index.ts"), {
    type: "file",
    rel: "src/helper/index.ts",
  });
  assert.deepEqual(graph.resolve("./util", "src/index.ts"), { type: "file", rel: "src/util.mjs" });
  assert.deepEqual(graph.resolve("./util.mjs", "src/index.ts"), {
    type: "file",
    rel: "src/util.mjs",
  });
  assert.equal(graph.resolve("../missing", "src/index.ts").type, "unresolved");
  assert.equal(graph.resolve("", "src/index.ts").type, "unresolved");
});

test("tsconfig paths and baseUrl resolve aliases, longest prefix first", async () => {
  const graph = await repo({
    "tsconfig.json": JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"], "@lib/*": ["lib/*"] } },
    }),
    "lib/foo.ts": "",
    "src/lib/foo.ts": "",
  });
  assert.deepEqual(graph.resolve("@lib/foo", "src/a.ts"), { type: "file", rel: "lib/foo.ts" });
  assert.deepEqual(graph.resolve("@/lib/foo", "src/a.ts"), { type: "file", rel: "src/lib/foo.ts" });
});

test("the star in a paths target can sit mid-path, and a `$&` in the specifier stays literal", async () => {
  const graph = await repo({
    "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "#*": ["src/*/index"] } } }),
    "src/feature/index.ts": "",
  });
  assert.deepEqual(graph.resolve("#feature", "a.ts"), {
    type: "file",
    rel: "src/feature/index.ts",
  });
  assert.equal(graph.resolve("#fea$&ture", "a.ts").type, "external");
});

test("jsconfig.json is used when there is no tsconfig.json, and a broken one is ignored", async () => {
  const withJs = await repo({
    "jsconfig.json": JSON.stringify({ compilerOptions: { paths: { "~/*": ["app/*"] } } }),
    "app/x.js": "",
  });
  assert.deepEqual(withJs.resolve("~/x", "a.js"), { type: "file", rel: "app/x.js" });
  const broken = await repo({ "tsconfig.json": "{ not json", "app/x.js": "" });
  assert.deepEqual(broken.resolve("~/x", "a.js"), { type: "external", pkg: "~" });
});

test("bare specifiers that are not workspace members are external", async () => {
  const graph = await repo({ "src/index.ts": "" });
  assert.deepEqual(graph.resolve("react", "src/index.ts"), { type: "external", pkg: "react" });
  assert.deepEqual(graph.resolve("react/jsx-runtime", "src/index.ts"), {
    type: "external",
    pkg: "react",
  });
  assert.deepEqual(graph.resolve("@scope/other/deep", "src/index.ts"), {
    type: "external",
    pkg: "@scope/other",
  });
});

test("workspace package names resolve to the member's entry file", async () => {
  const graph = await repo({
    "package.json": JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
    "packages/pkg/package.json": JSON.stringify({ name: "@scope/pkg" }),
    "packages/pkg/src/index.ts": "",
    "packages/bare/package.json": JSON.stringify({ name: "bare" }),
    "src/main.ts": "",
  });
  assert.deepEqual(graph.resolve("@scope/pkg", "src/main.ts"), {
    type: "file",
    rel: "packages/pkg/src/index.ts",
  });
  // A member with no entry file points at its manifest, for the caller to read.
  assert.deepEqual(graph.resolve("bare", "src/main.ts"), {
    type: "file",
    rel: "packages/bare/package.json",
  });
});

test("workspaces can be the { packages: [...] } form, and absent workspaces map nothing", async () => {
  const graph = await repo({
    "package.json": JSON.stringify({ workspaces: { packages: ["apps/*"] } }),
    "apps/web/package.json": JSON.stringify({ name: "web" }),
    "apps/web/index.ts": "",
  });
  assert.deepEqual(graph.resolve("web", "x.ts"), { type: "file", rel: "apps/web/index.ts" });
  const none = await repo({ "src/main.ts": "" });
  assert.deepEqual(none.resolve("web", "x.ts"), { type: "external", pkg: "web" });
});

test("a workspace manifest that cannot be read or parsed is skipped", async () => {
  const graph = await repo({
    "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
    "packages/bad/package.json": "{ nope",
  });
  assert.deepEqual(graph.resolve("bad", "x.ts"), { type: "external", pkg: "bad" });
});

test("the graph reports the file set it resolves against", async () => {
  const graph = await repo({ "a.ts": "", "b.ts": "" });
  assert.deepEqual([...graph.files].sort(), ["a.ts", "b.ts"]);
});
