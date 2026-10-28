import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// The three classifier CLIs share a flag contract but no parser: a typo has to
// fail loudly here, because the alternative is a script that judges less input
// than the caller passed and still exits 0.
for (const name of ["ci-triage", "memory-check", "promote-corrections"])
  test(`${name} rejects an unknown flag rather than ignoring it`, () => {
    const script = fileURLToPath(new URL(`./${name}.mjs`, import.meta.url));
    const run = spawnSync(process.execPath, [script, "--bogus"], { encoding: "utf8", input: "" });
    assert.equal(run.status, 2, `stderr: ${run.stderr}`);
    assert.match(run.stderr, new RegExp(`${name}: unknown flag --bogus`));
  });
