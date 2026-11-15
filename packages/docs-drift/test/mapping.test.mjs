import { test } from "node:test";
import assert from "node:assert/strict";

import { docRefs, isDocPath, mapDoc } from "../mapping.mjs";

test("isDocPath accepts READMEs, docs/ pages and agent-guidance files, and nothing else", () => {
  for (const path of [
    "README.md",
    "packages/a/README.md",
    "readme.markdown",
    "docs/guide.md",
    "packages/a/docs/deep/page.mdx",
    "docs/notes.txt",
    "AGENTS.md",
    "src/AGENTS.md",
    "CLAUDE.md",
    "GEMINI.md",
    ".github/copilot-instructions.md",
  ]) {
    assert.equal(isDocPath(path), true, path);
  }
  for (const path of [
    "src/index.mjs",
    "CHANGELOG.md",
    "docs/diagram.png",
    "docs/build.mjs",
    "notes/todo.md",
    "READMEfile.md",
  ]) {
    assert.equal(isDocPath(path), false, path);
  }
});

test("docRefs reads link targets and inline code, and skips fenced code, urls and anchors", () => {
  const text = [
    "# Title",
    "See [the parser](../src/parse.mjs#L10) and [site](https://example.com/x/y.js).",
    "Run `parseConfig()` after `src/load.mjs:42`, not `npm run check`.",
    "```js",
    "const hidden = `fenced/never.mjs`;",
    "```",
    "Also [top](#top) and `lib/`.",
  ].join("\n");
  const refs = docRefs(text);
  assert.deepEqual(refs.paths.sort(), ["../src/parse.mjs", "lib/", "src/load.mjs"]);
  assert.deepEqual(refs.identifiers, ["parseConfig"]);
});

test("docRefs keeps only identifiers that look like code, once each", () => {
  const refs = docRefs("`parseConfig` `parseConfig()` `max_size` `word` `Node` `a` `HTTP`");
  assert.deepEqual(refs.identifiers, ["parseConfig", "max_size"]);
});

const files = new Set([
  "README.md",
  "package.json",
  "src/parse.mjs",
  "src/load.mjs",
  "docs/guide.md",
  "docs/img.png",
  "pkg/README.md",
  "pkg/a.mjs",
  "pkg/deep/b.mjs",
  "pkg/deep/NOTES.md",
  "x/y.mjs",
  "x/z.mjs",
]);
const noGrep = async () => [];

test("mapDoc resolves a mention against the doc's directory, then the repo root", async () => {
  const mapped = await mapDoc({
    doc: "docs/guide.md",
    text: "See [parse](../src/parse.mjs), `src/load.mjs` and `package.json`.",
    files,
    find: noGrep,
  });
  assert.deepEqual(
    mapped.files.map((item) => item.path),
    ["package.json", "src/load.mjs", "src/parse.mjs"],
  );
  assert.ok(mapped.files.every((item) => item.via === "mentioned"));
});

test("mapDoc maps a mentioned directory to the files under it, but not other docs", async () => {
  const mapped = await mapDoc({
    doc: "README.md",
    text: "The code is in `pkg/`.",
    files,
    find: noGrep,
  });
  assert.deepEqual(mapped.dirs, ["pkg"]);
  assert.deepEqual(
    mapped.files.map((item) => item.path),
    ["pkg/a.mjs", "pkg/deep/b.mjs"],
  );
});

test("a README in a directory maps to that directory; a root README does not map to the repo", async () => {
  const inDir = await mapDoc({ doc: "pkg/README.md", text: "Nothing named.", files, find: noGrep });
  assert.deepEqual(inDir.dirs, ["pkg"]);
  assert.deepEqual(
    inDir.files.map((item) => [item.path, item.via]),
    [
      ["pkg/a.mjs", "directory"],
      ["pkg/deep/b.mjs", "directory"],
    ],
  );
  const root = await mapDoc({ doc: "README.md", text: "Nothing named.", files, find: noGrep });
  assert.deepEqual(root.files, []);
  assert.deepEqual(root.dirs, []);
});

test("mapDoc maps an identifier to the few files that use it and drops the ones used everywhere", async () => {
  const find = async (name) =>
    ({
      parseConfig: ["src/parse.mjs", "README.md"],
      everywhere: [
        "src/parse.mjs",
        "src/load.mjs",
        "pkg/a.mjs",
        "pkg/deep/b.mjs",
        "x/y.mjs",
        "x/z.mjs",
      ],
    })[name] ?? [];
  const mapped = await mapDoc({
    doc: "docs/guide.md",
    text: "`parseConfig()` and `everywhere()` and `unknownName()`.",
    files,
    find,
  });
  assert.deepEqual(mapped.files, [{ path: "src/parse.mjs", via: "identifier parseConfig" }]);
});

test("a mention that is not a tracked file is not mapped", async () => {
  const mapped = await mapDoc({
    doc: "docs/guide.md",
    text: "`src/gone.mjs` and [other](other.md) and `docs/img.png`.",
    files,
    find: noGrep,
  });
  assert.deepEqual(
    mapped.files.map((item) => item.path),
    ["docs/img.png"],
  );
});
