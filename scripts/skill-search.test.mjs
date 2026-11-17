import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./skill-search.mjs";

const script = fileURLToPath(new URL("./skill-search.mjs", import.meta.url));
// Local ranking only: the test must not reach TypeSafe even when a key is
// configured on the machine running it.
const env = { ...process.env, PI_SKILL_SELECT_TIEBREAK: "0", TYPESAFE_API_KEY: "" };

test("parseArgs reads the query, limit, roots and json flag", () => {
  assert.deepEqual(
    parseArgs(["find", "the", "skill", "--limit", "3", "--root", "/a", "--root=/b", "--json"]),
    {
      query: "find the skill",
      limit: 3,
      json: true,
      roots: ["/a", "/b"],
      help: false,
      error: null,
    },
  );
});

test("parseArgs reports bad values instead of guessing", () => {
  assert.match(parseArgs(["--limit", "0"]).error, /positive integer/);
  assert.match(parseArgs(["--limit"]).error, /positive integer/);
  assert.match(parseArgs(["--root"]).error, /needs a directory/);
  assert.equal(parseArgs(["--bogus"]).error, "unknown option: --bogus");
  assert.equal(parseArgs(["-h"]).help, true);
});

test("importing the module does not run a search", () => {
  // The import at the top of this file would have printed matches or exited
  // non-zero before the first assertion if the entry point were unguarded.
  assert.equal(typeof parseArgs, "function");
});

test("the CLI rejects an unknown option with exit 2 and the usage text", () => {
  const run = spawnSync(process.execPath, [script, "--bogus"], { encoding: "utf8", env });
  assert.equal(run.status, 2, run.stderr);
  assert.match(run.stderr, /unknown option: --bogus/);
  assert.match(run.stderr, /Usage:/);
});

test("a root with no skills finds nothing and exits 1", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "skill-search-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const run = spawnSync(process.execPath, [script, "anything", "--root", dir], {
    encoding: "utf8",
    env,
  });
  assert.equal(run.status, 1, run.stderr);
});
