import { test } from "node:test";
import assert from "node:assert/strict";

import { collectEdges, findCycles, loadImportGraph } from "../../../shared/import-graph.mjs";
import { parseTsSource } from "../ts-parser.mjs";

async function scan(tree, options = {}) {
  const readFile = async (rel) => tree[rel] ?? null;
  const files = Object.keys(tree);
  const graph = await loadImportGraph({ files, readFile });
  return collectEdges({
    graph,
    files: files.filter((file) => /\.(ts|mjs)$/.test(file)),
    readFile,
    parse: parseTsSource,
    ...options,
  });
}

test("every import form becomes an edge with its kind and line", async () => {
  const { edges, incomplete, scanned } = await scan({
    "src/a.ts": [
      'import { b } from "./b";',
      'import type { T } from "./types";',
      'export { c } from "./c";',
      'const lazy = import("./lazy");',
      'import fs from "node:fs";',
    ].join("\n"),
    "src/b.ts": "",
    "src/types.ts": "",
    "src/c.ts": "",
    "src/lazy.ts": "",
  });
  assert.equal(scanned, 5);
  assert.deepEqual(
    edges.filter((edge) => edge.from === "src/a.ts"),
    [
      { from: "src/a.ts", to: "src/b.ts", kind: "static", line: 1 },
      { from: "src/a.ts", to: "src/types.ts", kind: "type", line: 2 },
      { from: "src/a.ts", to: "src/c.ts", kind: "reexport", line: 3 },
      { from: "src/a.ts", to: "src/lazy.ts", kind: "dynamic", line: 4 },
    ],
  );
  // External packages are not part of the repository graph and are not a gap.
  assert.deepEqual(
    incomplete.map((entry) => entry.kind),
    ["dynamic-import"],
  );
});

test("a computed import() and an unresolved specifier are reported as incomplete", async () => {
  const { edges, incomplete } = await scan({
    "tsconfig.json": JSON.stringify({ compilerOptions: { paths: { "@/*": ["src/*"] } } }),
    "src/a.ts": 'import("./pages/" + name);\nimport { x } from "./gone";\nimport "@/alias/thing";',
  });
  assert.deepEqual(edges, []);
  assert.deepEqual(
    incomplete.map(({ kind, file, line }) => [kind, file, line]),
    [
      ["dynamic-import", "src/a.ts", 1],
      ["unresolved", "src/a.ts", 2],
      ["unresolved", "src/a.ts", 3],
    ],
  );
  assert.match(incomplete[1].detail, /\.\/gone/);
  assert.match(incomplete[2].detail, /@\/alias\/thing/);
});

test("an unreadable file, an oversized file and a parser failure are each reported", async () => {
  const tree = { "a.ts": "x".repeat(50), "b.ts": "", "c.ts": "" };
  const files = Object.keys(tree);
  const graph = await loadImportGraph({ files, readFile: async () => null });
  const result = await collectEdges({
    graph,
    files,
    readFile: async (rel) => (rel === "b.ts" ? null : tree[rel]),
    parse: (text) => {
      if (text === "") throw new Error("boom");
      return parseTsSource(text);
    },
    maxBytes: 10,
  });
  assert.deepEqual(
    result.incomplete.map(({ kind, file }) => [kind, file]),
    [
      ["too-large", "a.ts"],
      ["unreadable", "b.ts"],
      ["unparseable", "c.ts"],
    ],
  );
});

test("the file cap stops the scan and says how many files were left", async () => {
  const tree = { "a.ts": "", "b.ts": "", "c.ts": "", "d.ts": "" };
  const { scanned, incomplete } = await scan(tree, { maxFiles: 2 });
  assert.equal(scanned, 2);
  assert.deepEqual(incomplete, [
    {
      kind: "file-cap",
      file: null,
      line: null,
      detail: "2 source files beyond the 2 file limit were not read",
    },
  ]);
});

test("edges come out in a stable order whatever order the files are given in", async () => {
  const tree = { "b.ts": 'import "./a";', "a.ts": 'import "./b";' };
  const forward = await scan(tree);
  const backward = await scan(tree, { files: ["b.ts", "a.ts"] });
  assert.deepEqual(backward.edges, forward.edges);
  assert.deepEqual(
    forward.edges.map((edge) => edge.from),
    ["a.ts", "b.ts"],
  );
});

const edge = (from, to, kind = "static") => ({ from, to, kind, line: 1 });

test("findCycles returns one closed path per cycle, smallest file first", () => {
  const cycles = findCycles([
    edge("c.ts", "a.ts"),
    edge("a.ts", "b.ts"),
    edge("b.ts", "c.ts"),
    edge("x.ts", "a.ts"),
    edge("y.ts", "z.ts"),
    edge("z.ts", "y.ts"),
  ]);
  assert.deepEqual(cycles, [
    ["a.ts", "b.ts", "c.ts", "a.ts"],
    ["y.ts", "z.ts", "y.ts"],
  ]);
});

test("findCycles reports a file that imports itself", () => {
  assert.deepEqual(findCycles([edge("a.ts", "a.ts")]), [["a.ts", "a.ts"]]);
});

test("type-only and dynamic imports do not make a cycle, re-exports do", () => {
  assert.deepEqual(findCycles([edge("a.ts", "b.ts", "type"), edge("b.ts", "a.ts")]), []);
  assert.deepEqual(findCycles([edge("a.ts", "b.ts", "dynamic"), edge("b.ts", "a.ts")]), []);
  assert.deepEqual(findCycles([edge("a.ts", "b.ts", "reexport"), edge("b.ts", "a.ts")]), [
    ["a.ts", "b.ts", "a.ts"],
  ]);
});

test("findCycles copes with a long chain and with no edges", () => {
  const chain = Array.from({ length: 20_000 }, (_, i) => edge(`f${i}.ts`, `f${i + 1}.ts`));
  assert.deepEqual(findCycles(chain), []);
  assert.deepEqual(findCycles([]), []);
  chain.push(edge("f20000.ts", "f0.ts"));
  const [cycle] = findCycles(chain);
  assert.equal(cycle.length, 20_002);
});
