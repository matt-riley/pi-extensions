import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { atomicWriteFile, resolvePlanFile } from "../plan-file.mjs";

const BASE = "/proj/PLAN.md";
const noAlt = () => false;

test("first write with no existing file -> base", () => {
  assert.equal(
    resolvePlanFile({ base: BASE, plan: "p", existing: null, lastWritten: null, altTaken: noAlt }),
    BASE,
  );
});

test("existing is what we last wrote -> base", () => {
  assert.equal(
    resolvePlanFile({ base: BASE, plan: "p2", existing: "p1", lastWritten: "p1", altTaken: noAlt }),
    BASE,
  );
});

test("existing equals the new plan -> base (idempotent, survives restart)", () => {
  assert.equal(
    resolvePlanFile({ base: BASE, plan: "p1", existing: "p1", lastWritten: null, altTaken: noAlt }),
    BASE,
  );
});

test("existing differs from lastWritten -> .2", () => {
  assert.equal(
    resolvePlanFile({ base: BASE, plan: "p2", existing: "edited", lastWritten: "p1", altTaken: noAlt }),
    `${BASE}.2`,
  );
});

test("repeated revisions after an edit -> .2 then .3", () => {
  const taken = new Set([2]);
  assert.equal(
    resolvePlanFile({ base: BASE, plan: "p3", existing: "edited", lastWritten: "p2", altTaken: (n) => taken.has(n) }),
    `${BASE}.3`,
  );
});

test("unknown existing (lastWritten null) -> .2", () => {
  assert.equal(
    resolvePlanFile({ base: BASE, plan: "p2", existing: "stale", lastWritten: null, altTaken: noAlt }),
    `${BASE}.2`,
  );
});

test("alt collision loop skips taken numbers", () => {
  const taken = new Set([2, 3]);
  assert.equal(
    resolvePlanFile({ base: BASE, plan: "p", existing: "edited", lastWritten: "p0", altTaken: (n) => taken.has(n) }),
    `${BASE}.4`,
  );
});

test("atomicWriteFile writes and replaces content, leaves no temp files", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "plan-file-"));
  const file = path.join(dir, "PLAN.md");
  await atomicWriteFile(file, "one");
  assert.equal(await readFile(file, "utf8"), "one");
  await atomicWriteFile(file, "two");
  assert.equal(await readFile(file, "utf8"), "two");
  assert.deepEqual(await readdir(dir), ["PLAN.md"]);
});

test("atomicWriteFile cleans up temp on failure", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "plan-file-"));
  const file = path.join(dir, "PLAN.md");
  await writeFile(file, "keep");
  // Target directory does not exist, so the temp write (and rename) fail.
  await assert.rejects(() => atomicWriteFile(path.join(dir, "missing", "PLAN.md"), "x"));
  assert.deepEqual(await readdir(dir), ["PLAN.md"]);
});
