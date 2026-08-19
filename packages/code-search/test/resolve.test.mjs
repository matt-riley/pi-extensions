import { test } from "node:test";
import assert from "node:assert/strict";
import {
  loadWorkspaceMap,
  parseTsconfigPaths,
  resolveDefinition,
  resolveSpecifier,
} from "../resolve.mjs";

const def = (name, kind = "function", extra = {}) => ({
  name, kind, startLine: 1, endLine: 1, exported: true, signature: "", ...extra,
});
const entry = ({ symbols = [], imports = [], reexports = [] } = {}) => ({ symbols, imports, reexports, size: 100, lang: "ts" });

const BASE = {
  "src/index.ts": entry({
    imports: [{ names: [{ imported: "default", local: "helper" }], source: "./helper" }],
  }),
  // No src/helper.ts — exercises index-file probing.
  "src/helper/index.ts": entry({ symbols: [def("helper")] }),
  "src/alias.ts": entry({
    imports: [{ names: [{ imported: "foo", local: "foo" }], source: "@lib/foo" }],
  }),
  "lib/foo.ts": entry({ symbols: [def("foo")] }),
  "src/barrel.ts": entry({ reexports: [{ names: [{ imported: "deep", local: "deep" }], source: "./deep" }] }),
  "src/deep.ts": entry({ reexports: [{ names: null, source: "./deeper" }] }),
  "src/deeper.ts": entry({ symbols: [def("deep", "function", { exported: true })] }),
  "src/alias2.ts": entry({
    imports: [{ names: [{ imported: "stuff", local: "stuff" }], source: "@scope/pkg" }],
  }),
};

const readFile = async (rel) => {
  const content = {
    "src/index.ts": "import helper from './helper';\n",
    "src/helper/index.ts": "export default function helper() {}\n",
    "src/alias.ts": "import { foo } from '@lib/foo';\n",
    "lib/foo.ts": "export function foo() {}\n",
    "src/deeper.ts": "export function deep() {}\n",
    "src/barrel.ts": "export { deep } from './deep';\n",
    "src/deep.ts": "export * from './deeper';\n",
    "packages/pkg/package.json": '{"name":"@scope/pkg","main":"src/index.ts"}',
    "packages/pkg/src/index.ts": "export const stuff = 1;\n",
  };
  return content[rel] ?? null;
};

const ctx = (overrides = {}) => ({
  cache: { files: { ...BASE, ...overrides } },
  tsconfig: null,
  workspaceMap: null,
  readFile,
});

test("parseTsconfigPaths extracts baseUrl and paths", () => {
  const parsed = parseTsconfigPaths({
    compilerOptions: {
      baseUrl: ".",
      paths: { "@/*": ["src/*"], "@lib/*": ["lib/*"] },
    },
  });
  assert.deepEqual(parsed.entries, [
    { pattern: "@/*", target: "src/*" },
    { pattern: "@lib/*", target: "lib/*" },
  ]);
  assert.equal(parsed.baseUrl, "");
  assert.equal(parseTsconfigPaths({ compilerOptions: {} }), null);
});

test("resolveSpecifier: relative with extension and index probing", () => {
  const fileSet = new Set(Object.keys(BASE));
  assert.deepEqual(resolveSpecifier("./helper", "src/index.ts", { fileSet, tsconfig: null, workspaceMap: null }),
    { type: "file", rel: "src/helper/index.ts" });
  assert.deepEqual(resolveSpecifier("../missing", "src/index.ts", { fileSet, tsconfig: null, workspaceMap: null }).type,
    "unresolved");
});

test("resolveSpecifier: tsconfig path aliases", () => {
  const fileSet = new Set(Object.keys(BASE));
  const tsconfig = parseTsconfigPaths({
    compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"], "@lib/*": ["lib/*"] } },
  });
  const r = resolveSpecifier("@lib/foo", "src/alias.ts", { fileSet, tsconfig, workspaceMap: null });
  assert.deepEqual(r, { type: "file", rel: "lib/foo.ts" });
});

test("resolveSpecifier: bare specifier → external", () => {
  const fileSet = new Set(Object.keys(BASE));
  assert.deepEqual(
    resolveSpecifier("react", "src/index.ts", { fileSet, tsconfig: null, workspaceMap: new Map() }),
    { type: "external", pkg: "react" },
  );
  assert.deepEqual(
    resolveSpecifier("@scope/other", "src/index.ts", { fileSet, tsconfig: null, workspaceMap: new Map() }),
    { type: "external", pkg: "@scope/other" },
  );
});

test("resolveDefinition: fromFile import resolves to the defining file", async () => {
  const r = await resolveDefinition({ symbol: "helper", fromFile: "src/index.ts", ...ctx() });
  assert.equal(r.primaryRel, "src/helper/index.ts");
  assert.equal(r.external, null);
  assert.ok(r.candidates.some((c) => c.rel === "src/helper/index.ts"));
});

test("resolveDefinition: follows re-export chains to the real definition", async () => {
  const r = await resolveDefinition({ symbol: "deep", fromFile: "src/barrel.ts", ...ctx() });
  assert.equal(r.primaryRel, "src/deeper.ts");
});

test("resolveDefinition: external imports are reported, not scanned", async () => {
  const cache = {
    files: {
      "src/app.ts": entry({
        imports: [{ names: [{ imported: "default", local: "react" }], source: "react" }],
      }),
    },
  };
  const r = await resolveDefinition({ symbol: "react", fromFile: "src/app.ts", cache, tsconfig: null, workspaceMap: new Map(), readFile: async () => "x" });
  assert.equal(r.external, "react");
  assert.equal(r.primaryRel, null);
});

test("resolveDefinition: global scan lists exported definitions first", async () => {
  const cache = {
    files: {
      "src/one.ts": entry({ symbols: [def("util", "function", { exported: false, startLine: 3 })] }),
      "src/two.ts": entry({ symbols: [def("util", "function", { exported: true, startLine: 1 })] }),
    },
  };
  const r = await resolveDefinition({ symbol: "util", cache, tsconfig: null, workspaceMap: null, readFile: async () => "export function util() {}" });
  assert.equal(r.candidates[0].rel, "src/two.ts");
  assert.equal(r.external, null);
});

test("resolveDefinition: kind filter narrows candidates", async () => {
  const cache = {
    files: {
      "src/one.ts": entry({
        symbols: [def("thing", "class"), def("thing", "type", { startLine: 5 })],
      }),
    },
  };
  const r = await resolveDefinition({ symbol: "thing", kind: "type", cache, tsconfig: null, workspaceMap: null, readFile: async () => "x" });
  assert.ok(r.candidates.every((c) => c.kind === "type"));
});

test("resolveDefinition: no candidates suggests near names", async () => {
  const cache = {
    files: {
      "src/one.ts": entry({ symbols: [def("greeter"), def("groot")] }),
    },
  };
  const r = await resolveDefinition({ symbol: "greetr", cache, tsconfig: null, workspaceMap: null, readFile: async () => "x" });
  assert.equal(r.candidates.length, 0);
  assert.ok(r.note.includes("did you mean"));
  assert.ok(r.note.includes("greeter"));
});

test("resolveDefinition: re-export cycles terminate", async () => {
  const cache = {
    files: {
      "src/a.ts": entry({ reexports: [{ names: null, source: "./b" }] }),
      "src/b.ts": entry({ reexports: [{ names: null, source: "./a" }] }),
    },
  };
  const r = await resolveDefinition({ symbol: "loop", fromFile: "src/a.ts", cache, tsconfig: null, workspaceMap: null, readFile: async () => "x" });
  // No crash, no definition found
  assert.equal(r.primaryRel, null);
  assert.ok(r.note.includes("no definition"));
});

test("loadWorkspaceMap maps workspace package names to dirs", async () => {
  const json = { name: "root", workspaces: ["packages/*"] };
  const files = ["packages/pkg/package.json", "packages/pkg/src/index.ts", "src/main.ts"];
  const map = await loadWorkspaceMap({ files, readFile, json });
  assert.equal(map.get("@scope/pkg"), "packages/pkg");
});

test("loadWorkspaceMap: scoped-glob and missing workspaces", async () => {
  const none = await loadWorkspaceMap({ files: ["src/main.ts"], readFile, json: null });
  assert.equal(none.size, 0);
  const glob = await loadWorkspaceMap({
    files: ["apps/web/package.json"],
    readFile: async () => '{"name":"web"}',
    json: { workspaces: { packages: ["apps/*"] } },
  });
  assert.equal(glob.get("web"), "apps/web");
});
