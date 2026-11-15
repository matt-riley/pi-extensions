import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { agentFileChecks, routerState } from "../files.mjs";

function dir(t) {
  const root = mkdtempSync(join(tmpdir(), "doctor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("router.json: absent is `missing`, good is `ok`, broken is `invalid` with the reason", (t) => {
  const root = dir(t);
  const file = join(root, "router.json");
  assert.equal(routerState(file).state, "missing");
  writeFileSync(file, JSON.stringify({ base: ["a"] }));
  assert.deepEqual(routerState(file), { state: "ok", path: file });
  writeFileSync(file, "{ nope");
  const bad = routerState(file);
  assert.equal(bad.state, "invalid");
  assert.match(bad.error, /not valid JSON/);
  writeFileSync(file, "[1]");
  assert.match(routerState(file).error, /must be a JSON object/);
});

test("agent files: parsed ones are ok, an unparseable one is named with the parser's error", (t) => {
  const root = dir(t);
  mkdirSync(join(root, "agents"));
  writeFileSync(join(root, "agents", "good.md"), "---\nname: good\ndescription: x\n---\nbody\n");
  writeFileSync(join(root, "agents", "bad.md"), "---\nname: [oops\n---\nbody\n");
  writeFileSync(join(root, "agents", "notes.txt"), "ignored");
  const parseFrontmatter = (text) => {
    if (text.includes("[oops")) throw new Error("bad yaml");
    return { frontmatter: { name: "x" }, body: "b" };
  };
  const files = agentFileChecks([join(root, "agents"), join(root, "missing")], {
    parseFrontmatter,
  });
  assert.deepEqual(
    files.map((f) => [f.path.split("/").pop(), f.ok]),
    [
      ["bad.md", false],
      ["good.md", true],
    ],
  );
  assert.match(files[0].error, /bad yaml|does not parse/);
});

test("a directory that cannot be read is an error for the caller (unknown), not an empty list", (t) => {
  const root = dir(t);
  writeFileSync(join(root, "agents"), "a file where a directory should be");
  assert.throws(() => agentFileChecks([join(root, "agents")], { parseFrontmatter: () => ({}) }));
});
