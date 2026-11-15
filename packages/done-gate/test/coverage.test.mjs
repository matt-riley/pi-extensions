import { test } from "node:test";
import assert from "node:assert/strict";
import { coverageForRun, isTestCommand, scanSpecifiers, testReach } from "../coverage.mjs";

const ALL = [
  "src/gate.mjs",
  "src/other.mjs",
  "test/gate.test.mjs",
  "test/other.test.mjs",
  "test/names.test.mjs",
  "test/unrelated.test.mjs",
];

const SOURCES = {
  "test/gate.test.mjs": 'import { run } from "../src/gate.mjs";\nrun();\n',
  "test/other.test.mjs": 'import { run } from "../src/other.mjs";\nrun();\n',
  "test/names.test.mjs":
    'import { readFileSync } from "node:fs";\nreadFileSync(new URL("../src/gate.mjs", import.meta.url));\n',
  "test/unrelated.test.mjs": 'import assert from "node:assert";\nassert.ok(true);\n',
  "package.json": JSON.stringify({ scripts: { test: "node --test test/gate.test.mjs" } }),
};

const world = (sources = SOURCES, all = ALL) => ({
  read: async (path) => sources[path] ?? null,
  listTests: async () => all,
});

const run = (command, { log = "", edited = ["src/gate.mjs"], ...rest } = {}) =>
  coverageForRun({ command, log, edited, cwd: "/repo", ...world(), ...rest });

test("only a unit-test runner is a test command", () => {
  for (const command of [
    "node --test",
    "npm test",
    "rtk npm run test",
    "pytest -q",
    "npx vitest run",
    "go test ./...",
    "cargo test",
    "make test",
    "deno test -A",
    "dotnet test",
    "bundle exec rspec",
    "npx mocha",
  ])
    assert.equal(isTestCommand(command), true, command);
  for (const command of [
    "npm run check",
    "npm run typecheck",
    "bash .pi/verify",
    "npx tsc --noEmit",
    "stylua --check .",
    "./scripts/test.sh",
    "npm run smoke",
    "deno check main.ts",
  ])
    assert.equal(isTestCommand(command), false, command);
});

test("a test file that imports a changed file counts", async () => {
  assert.equal(await run("node --test test/gate.test.mjs"), "yes");
});

test("a test file that only names a changed file counts", async () => {
  assert.equal(await run("node --test test/names.test.mjs"), "yes");
});

test("an unrelated test file does not count", async () => {
  assert.equal(await run("node --test test/other.test.mjs test/unrelated.test.mjs"), "no");
});

test("one covering file among several is enough", async () => {
  assert.equal(await run("node --test test/unrelated.test.mjs test/gate.test.mjs"), "yes");
});

test("a changed test file that ran counts", async () => {
  assert.equal(
    await run("node --test test/unrelated.test.mjs", { edited: ["test/unrelated.test.mjs"] }),
    "yes",
  );
});

test("files named in the log count when the command names none", async () => {
  const log = "PASS test/gate.test.mjs (3 tests)\nPASS test/other.test.mjs\n";
  assert.equal(await run("npx vitest run", { log }), "yes");
  assert.equal(await run("npx vitest run", { log: "PASS test/other.test.mjs\n" }), "no");
});

test("a bare run and a directory run take every test file under it", async () => {
  assert.equal(await run("node --test"), "yes");
  assert.equal(await run("node --test test/"), "yes");
  assert.equal(await run("node --test 'test/*.test.mjs'"), "yes");
  assert.equal(await run("node --test", { edited: ["src/untested.mjs"] }), "no");
});

test("deno test finds _test files itself", async () => {
  const deno = world({ "tests/a_test.ts": 'import { a } from "../src/a.ts";' }, [
    "tests/a_test.ts",
  ]);
  assert.equal(await run("deno test", { ...deno, edited: ["src/a.ts"] }), "yes");
  assert.equal(await run("deno test", { ...deno, edited: ["src/b.ts"] }), "no");
});

test("npm test is read through the test script in package.json", async () => {
  assert.equal(await run("npm test"), "yes");
  assert.equal(await run("npm test", { edited: ["src/other.mjs"] }), "no");
  const named = world({
    ...SOURCES,
    "package.json": JSON.stringify({ scripts: { "test:unit": "node --test test/other.test.mjs" } }),
  });
  assert.equal(await run("npm run test:unit", { ...named, edited: ["src/other.mjs"] }), "yes");
  assert.equal(await run("npm run test:unit", { ...named }), "no");
});

test("when the files the run covered cannot be worked out, the answer is unknown", async () => {
  assert.equal(await run("cargo test"), "unknown");
  assert.equal(await run("make test"), "unknown");
  const noScript = { ...SOURCES, "package.json": JSON.stringify({ scripts: { test: "tap" } }) };
  assert.equal(await run("npm test", { ...world(noScript) }), "unknown");
  assert.equal(await run("npm test", { ...world({}) }), "unknown");
});

test("go test covers the packages it names: a _test.go beside the changed file is the same package", async () => {
  const go = world({}, ["pkg/foo/a_test.go", "pkg/bar/b_test.go", "root_test.go"]);
  const at = (command, edited) => run(command, { ...go, edited });
  assert.equal(await at("go test ./pkg/foo", ["pkg/foo/a.go"]), "yes");
  assert.equal(await at("go test ./pkg/foo/...", ["pkg/foo/a.go"]), "yes");
  assert.equal(await at("go test ./...", ["pkg/bar/b.go"]), "yes");
  assert.equal(await at("go test ./pkg/foo", ["pkg/bar/b.go"]), "no");
  assert.equal(await at("go test", ["root.go"]), "yes");
  assert.equal(await at("go test", ["pkg/foo/a.go"]), "no");
  assert.equal(await at("go test ./pkg/baz", ["pkg/baz/c.go"]), "no");
});

test("an unreadable test file is unknown, not a miss", async () => {
  const gone = { ...SOURCES };
  delete gone["test/other.test.mjs"];
  assert.equal(await run("node --test test/other.test.mjs", { ...world(gone) }), "unknown");
});

test("prose, config and other files tests cannot import are not judged", async () => {
  assert.equal(await run("node --test test/other.test.mjs", { edited: ["config.json"] }), "yes");
  assert.equal(await run("go test ./...", { edited: ["data.yml"] }), "yes");
});

test("a check that is not a test run is not judged here", async () => {
  assert.equal(await run("bash .pi/verify"), "yes");
});

test("scanSpecifiers reads import, export, require and dynamic import", () => {
  const source = [
    'import a from "./a.mjs";',
    "import { b } from '../b';",
    'import "./side.mjs";',
    'export { c } from "./c.js";',
    'const d = require("./d");',
    'const e = await import("./e.mjs");',
    "import type { T } from './t';",
    "// import x from './commented-but-fine';",
  ].join("\n");
  const found = scanSpecifiers(source, "x.test.mjs");
  for (const spec of ["./a.mjs", "../b", "./side.mjs", "./c.js", "./d", "./e.mjs", "./t"])
    assert.ok(found.includes(spec), spec);
});

test("scanSpecifiers reads python and lua module imports", () => {
  const py = "import pkg.mod\nfrom pkg.other import thing\nfrom .sibling import x\n";
  const found = scanSpecifiers(py, "tests/test_a.py");
  assert.ok(found.includes("pkg.mod") && found.includes("pkg.other") && found.includes(".sibling"));
  assert.ok(
    scanSpecifiers('local m = require("app.core")', "spec/core_spec.lua").includes("app.core"),
  );
});

test("testReach resolves relative imports against the test file", () => {
  const at = (source, changed, file = "test/a.test.mjs") =>
    testReach({ testPath: file, source, changed: [changed] });
  assert.equal(at('import "../src/x.ts";', "src/x.ts"), "imports");
  assert.equal(at('import "../src/x.js";', "src/x.ts"), "imports");
  assert.equal(at('import "../src/x";', "src/x.mjs"), "imports");
  assert.equal(at('import "../src";', "src/index.ts"), "imports");
  assert.equal(at('import "../src/x.ts";', "src/y.ts"), null);
  assert.equal(at('import "../src/xy.ts";', "src/x.ts"), null);
});

test("testReach matches module-style imports by trailing path", () => {
  const at = (source, changed, file) => testReach({ testPath: file, source, changed: [changed] });
  assert.equal(at("from pkg.mod import f", "lib/pkg/mod.py", "tests/test_mod.py"), "imports");
  assert.equal(at("from .mod import f", "tests/mod.py", "tests/test_mod.py"), "imports");
  assert.equal(at('require("app.core")', "lua/app/core.lua", "spec/core_spec.lua"), "imports");
  assert.equal(at('import "@/src/x"', "src/x.ts", "test/a.test.ts"), "imports");
  assert.equal(at('import "fs"', "src/fs.ts", "test/a.test.ts"), null);
});

test("testReach counts a name in the source only with its extension", () => {
  const at = (source, changed) =>
    testReach({ testPath: "t/a.test.mjs", source, changed: [changed] });
  assert.equal(at('spawn("node", ["bin/tool.mjs"])', "bin/tool.mjs"), "names");
  assert.equal(at('join(here, "..", "gate.mjs")', "src/gate.mjs"), "names");
  assert.equal(at("the gate is documented", "src/gate.mjs"), null);
  assert.equal(at("gate.mjsx", "src/gate.mjs"), null);
  assert.equal(at('"packages/a/index.ts"', "packages/a/index.ts"), "names");
  assert.equal(at('"index.ts"', "packages/a/index.ts"), null);
});
