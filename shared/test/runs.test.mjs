import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { appendRunRow, startRunLog } from "../runs.mjs";

test("a run row carries its timestamp and keeps cells on one line", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "runs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = startRunLog(dir, "until", "at\titeration\tcode\n");
  appendRunRow(path, [1, 0]);
  appendRunRow(path, ["two\nlines", 3]);
  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 3);
  const [at, ...cells] = lines[1].split("\t");
  assert.ok(!Number.isNaN(Date.parse(at)), "the first cell is an ISO timestamp");
  assert.deepEqual(cells, ["1", "0"]);
  assert.deepEqual(lines[2].split("\t").slice(1), ["two lines", "3"]);
});

test("a log that cannot be appended to does not throw into the loop", () => {
  assert.doesNotThrow(() => appendRunRow(join(tmpdir(), "no-such-runs-dir", "run.tsv"), [1]));
});
