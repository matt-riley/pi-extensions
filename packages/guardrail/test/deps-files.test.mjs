import { test } from "node:test";
import assert from "node:assert/strict";

import { fileDependencyChanges } from "../deps.mjs";

const pkg = (fields) => JSON.stringify(fields, null, 2) + "\n";
const base = pkg({
  name: "app",
  version: "1.0.0",
  scripts: { build: "tsc", test: "node --test" },
  dependencies: { zod: "^3.0.0" },
  devDependencies: { typescript: "^5.0.0" },
});
const edit = (oldText, newText) => ({ path: "package.json", edits: [{ oldText, newText }] });
const changes = (path, input, before) => fileDependencyChanges({ path, input, before });

test("adding a package to any dependency section is a change", () => {
  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const next = JSON.parse(base);
    next[section] = { ...next[section], "left-pad": "^1.3.0" };
    assert.deepEqual(
      changes("package.json", { path: "package.json", content: pkg(next) }, base),
      [{ file: "package.json", section, name: "left-pad", from: null, to: "^1.3.0" }],
      section,
    );
  }
});

test("an edit is applied to the file on disk before comparing", () => {
  assert.deepEqual(
    changes(
      "package.json",
      edit('"zod": "^3.0.0"', '"zod": "^3.0.0",\n    "left-pad": "^1.3.0"'),
      base,
    ),
    [{ file: "package.json", section: "dependencies", name: "left-pad", from: null, to: "^1.3.0" }],
  );
});

test("changing the range of an existing dependency is a change; removing one is not", () => {
  assert.deepEqual(changes("package.json", edit('"^3.0.0"', '"^4.0.0"'), base), [
    { file: "package.json", section: "dependencies", name: "zod", from: "^3.0.0", to: "^4.0.0" },
  ]);
  const dropZod = '"dependencies": {\n    "zod": "^3.0.0"\n  },\n  ';
  assert.ok(base.includes(dropZod), "fixture drifted: the removal edit would be vacuous");
  assert.deepEqual(changes("package.json", edit(dropZod, ""), base), []);
  const removed = pkg({ ...JSON.parse(base), dependencies: {} });
  assert.deepEqual(changes("package.json", { path: "package.json", content: removed }, base), []);
});

test("scripts, the package version and other fields never trigger", () => {
  assert.deepEqual(changes("package.json", edit('"tsc"', '"tsc && left-pad"'), base), []);
  assert.deepEqual(changes("package.json", edit('"1.0.0"', '"1.1.0"'), base), []);
  assert.deepEqual(changes("package.json", edit('"name": "app"', '"name": "app2"'), base), []);
  const next = { ...JSON.parse(base), description: "hi", scripts: { lint: "oxlint" } };
  assert.deepEqual(changes("package.json", { path: "package.json", content: pkg(next) }, base), []);
});

test("a new package.json written with dependencies lists them all", () => {
  const content = pkg({ name: "x", dependencies: { a: "1", b: "2" } });
  const found = changes("package.json", { path: "package.json", content }, undefined);
  assert.deepEqual(
    found.map((c) => c.name),
    ["a", "b"],
  );
});

test("a nested package.json counts and a differently named file does not", () => {
  const content = pkg({ dependencies: { a: "1" } });
  assert.equal(changes("/r/packages/x/package.json", { content }, "{}").length, 1);
  assert.deepEqual(changes("/r/package.json.bak", { content }, "{}"), []);
  assert.deepEqual(changes("/r/notes.json", { content }, "{}"), []);
  assert.deepEqual(changes("/r/node_modules/x/package.json", { content }, "{}"), []);
});

test("an edit that leaves invalid JSON is not judged, but fixing a broken file is", () => {
  assert.deepEqual(
    changes("package.json", edit('"zod"', '"left-pad": "1", "zod"'), base).length,
    1,
  );
  assert.deepEqual(changes("package.json", edit('"zod": "^3.0.0"', '"zod": '), base), []);
  const broken = '{ "dependencies": { "a": "1" ';
  const fixed = pkg({ dependencies: { a: "1" } });
  assert.equal(changes("package.json", { content: fixed }, broken).length, 1);
});

test("an edit whose text is not in the file, or an unreadable file, changes nothing", () => {
  assert.deepEqual(changes("package.json", edit("not there", "x"), base), []);
  assert.deepEqual(changes("package.json", edit('"zod"', '"x"'), undefined), []);
  assert.deepEqual(changes("package.json", { path: "package.json" }, base), []);
  assert.deepEqual(changes("package.json", undefined, base), []);
  assert.deepEqual(fileDependencyChanges({}), []);
});

const goMod = `module example.com/app

go 1.23

require github.com/pkg/errors v0.9.1

require (
\tgolang.org/x/text v0.14.0
\texample.com/old v1.0.0 // indirect
)

replace example.com/old => ../old
`;

test("go.mod require lines: an added or bumped module is a change", () => {
  const added = goMod.replace(
    "require github.com/pkg/errors v0.9.1",
    "require github.com/pkg/errors v0.9.1\nrequire example.com/new v1.2.3",
  );
  assert.deepEqual(changes("go.mod", { path: "go.mod", content: added }, goMod), [
    { file: "go.mod", section: "require", name: "example.com/new", from: null, to: "v1.2.3" },
  ]);
  assert.deepEqual(
    changes("go.mod", edit("v0.14.0", "v0.15.0"), goMod).map((c) => c.name),
    ["golang.org/x/text"],
  );
  assert.deepEqual(
    changes(
      "go.mod",
      {
        path: "go.mod",
        edits: [
          { oldText: "v1.0.0 // indirect", newText: "v1.0.0 // indirect\n\texample.com/b v0.1.0" },
        ],
      },
      goMod,
    ).map((c) => c.name),
    ["example.com/b"],
  );
});

test("go.mod edits to go, module, replace lines and comments do not trigger", () => {
  assert.deepEqual(changes("go.mod", edit("go 1.23", "go 1.24"), goMod), []);
  assert.deepEqual(
    changes("go.mod", edit("module example.com/app", "module example.com/app2"), goMod),
    [],
  );
  assert.deepEqual(changes("go.mod", edit("../old", "../older"), goMod), []);
  assert.deepEqual(changes("go.mod", edit(" // indirect", ""), goMod), []);
});
