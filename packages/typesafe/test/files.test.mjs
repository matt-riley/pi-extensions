// files.mjs against a real temp repo (no git: the fake exec fails, so the
// inventory falls back to the node walker) and a fake `ask`. Pinned: what may
// be read, what may run, that content stays out of the agent's hands, and that
// ranking and failure reporting behave.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  askFiles,
  formatFileResults,
  gateCommand,
  loadText,
  resolveReadable,
  resolveTargets,
  runCommand,
} from "../files.mjs";

const noGit = async () => ({ code: 1, stdout: "", stderr: "" });
const noul = (value) => ({ type: "noul", noul: value });

let dir;
let outside;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "typesafe-files-"));
  outside = mkdtempSync(join(tmpdir(), "typesafe-outside-"));
  for (const sub of ["src/sub", "node_modules/x"]) mkdirSync(join(dir, sub), { recursive: true });
  writeFileSync(join(dir, "src/a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "src/b.ts"), "export const b = 2;\n");
  writeFileSync(join(dir, "src/sub/c.ts"), "export const c = 3;\n");
  writeFileSync(join(dir, "README.md"), "# readme\n");
  writeFileSync(join(dir, ".env"), "TOKEN=abc\n");
  writeFileSync(join(dir, "node_modules/x/i.js"), "x\n");
  writeFileSync(join(dir, "bin.dat"), Buffer.from([1, 2, 0, 3]));
  writeFileSync(join(outside, "secret.ts"), "leak\n");
  symlinkSync(join(outside, "secret.ts"), join(dir, "link.ts"));
  symlinkSync(join(dir, ".env"), join(dir, "envlink.ts"));
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const resolveIn = (patterns, options = {}) =>
  resolveTargets({ patterns, cwd: dir, exec: noGit, ...options });

test("globs, directories and literals expand against the inventory", async () => {
  assert.deepEqual((await resolveIn(["src/**/*.ts"])).files.sort(), [
    "src/a.ts",
    "src/b.ts",
    "src/sub/c.ts",
  ]);
  assert.deepEqual((await resolveIn(["src/*.ts"])).files.sort(), ["src/a.ts", "src/b.ts"]);
  assert.deepEqual((await resolveIn(["src"])).files.sort(), ["src/a.ts", "src/b.ts"]);
  assert.equal((await resolveIn(["src"], { recursive: true })).files.length, 3);
  assert.deepEqual((await resolveIn(["README.md"])).files, ["README.md"]);
});

test("node_modules never appears, and secrets, escapes and misses are reported", async () => {
  assert.deepEqual((await resolveIn(["**/*.js"])).files, []);
  const result = await resolveIn([".env", "../outside", "nope/*.ts", "missing.txt"]);
  assert.deepEqual(result.files, []);
  const reasons = Object.fromEntries(result.skipped.map((s) => [s.path, s.reason]));
  assert.equal(reasons[".env"], "looks like a secret");
  assert.equal(reasons["../outside"], "outside the repository");
  assert.equal(reasons["nope/*.ts"], "no match");
  assert.equal(reasons["missing.txt"], "no match");
});

test("a glob that matches a secret drops it and says so", async () => {
  const result = await resolveIn([".*"]);
  assert.ok(!result.files.includes(".env"));
  assert.ok(result.skipped.some((s) => s.path === ".env" && s.reason === "looks like a secret"));
});

test("loadText refuses symlinks out of the repo or onto secrets, binaries and non-files", async () => {
  assert.equal((await loadText(dir, "link.ts")).skip, "outside the repository");
  assert.equal((await loadText(dir, "envlink.ts")).skip, "looks like a secret");
  assert.equal((await loadText(dir, "bin.dat")).skip, "binary");
  assert.equal((await loadText(dir, "src")).skip, "not a file");
  assert.match((await loadText(dir, "src/a.ts")).text, /export const a/);
});

test("resolveReadable throws the reason for a path it will not read", async () => {
  await assert.rejects(
    resolveReadable({ path: ".env", cwd: dir, exec: noGit }),
    /looks like a secret/,
  );
  await assert.rejects(
    resolveReadable({ path: "../x", cwd: dir, exec: noGit }),
    /outside the repository/,
  );
  const ok = await resolveReadable({ path: "src/a.ts", cwd: dir, exec: noGit });
  assert.equal(ok.rel, "src/a.ts");
});

test("gateCommand allows read-only commands and refuses mutators and secret reads", () => {
  assert.equal(gateCommand("ls -la src", dir), null);
  assert.equal(gateCommand("git diff --stat", dir), null);
  assert.match(gateCommand("rm -rf src", dir), /not read-only/);
  assert.match(gateCommand("echo x > file.txt", dir), /not read-only/);
  assert.match(gateCommand("cat ~/.ssh/id_rsa", dir), /guardrail/);
});

test("runCommand runs in cwd through exec and caps the output", async () => {
  let call;
  const exec = async (...args) => (
    (call = args),
    { code: 0, stdout: "x".repeat(200_000), stderr: "warn" }
  );
  const out = await runCommand({ command: "ls", cwd: dir, exec });
  assert.deepEqual(call[1].slice(2), [dir, "ls"]);
  assert.equal(out.exit_code, 0);
  assert.ok(out.output.length < 101_000);
});

test("askFiles gives each file its own request with shared state, and marks truncation", async () => {
  writeFileSync(join(dir, "big.txt"), "y".repeat(70_000));
  const seen = [];
  const ask = async ({ state }) => (seen.push(state), { answers: { q: noul(0.5) } });
  const results = await askFiles({
    root: dir,
    files: ["src/a.ts", "big.txt", "bin.dat"],
    questions: { q: { type: "noul", instructions: "?" } },
    shared: { command_output: { output: "out" } },
    ask,
  });
  assert.equal(seen.length, 2);
  // Requests arrive in completion order, so look them up by path.
  const byPath = Object.fromEntries(seen.map((state) => [state.file.path, state]));
  assert.equal(byPath["src/a.ts"].command_output.output, "out");
  assert.equal(byPath["src/a.ts"].file.truncated, false);
  assert.equal(byPath["big.txt"].file.truncated, true);
  assert.equal(byPath["big.txt"].file.content.length, 60_000);
  assert.equal(results[2].skipped, "binary");
});

test("askFiles keeps going past one failing file but throws when every file fails", async () => {
  const questions = { q: { type: "noul", instructions: "?" } };
  const flaky = async ({ state }) => {
    if (state.file.path === "src/b.ts") throw new Error("boom");
    return { answers: { q: noul(0.9) } };
  };
  const partial = await askFiles({
    root: dir,
    files: ["src/a.ts", "src/b.ts"],
    questions,
    ask: flaky,
  });
  assert.equal(partial[0].answers.q.noul, 0.9);
  assert.equal(partial[1].error, "boom");
  const down = async () => {
    throw new Error("TYPESAFE_API_KEY is not set");
  };
  await assert.rejects(
    askFiles({ root: dir, files: ["src/a.ts", "src/b.ts"], questions, ask: down }),
    /TYPESAFE_API_KEY/,
  );
});

test("formatFileResults ranks by a question, unusable values last, and lists skips", () => {
  const results = [
    {
      path: "low",
      answers: { auth: noul(0.1), kind: { type: "choice", choice: "util", confidence: 0.8 } },
    },
    { path: "none", answers: { auth: noul(null) } },
    { path: "high", answers: { auth: noul(0.9) } },
    { path: "bad", error: "boom" },
    { path: "bin", skipped: "binary" },
  ];
  const text = formatFileResults({
    results,
    skipped: [{ path: ".env", reason: "looks like a secret" }],
    rankBy: "auth",
  });
  const order = text
    .split("\n")
    .filter((l) => /^(low|none|high):/.test(l))
    .map((l) => l.split(":")[0]);
  assert.deepEqual(order, ["high", "low", "none"]);
  assert.match(text, /3 file\(s\) judged, ranked by auth \(highest first\), 1 failed, 2 skipped/);
  assert.match(text, /low: auth noul 0\.10 · kind choice "util" \(0\.80\)/);
  assert.match(text, /none: auth n\/a/);
  assert.match(text, /bad: failed: boom/);
  assert.match(text, /\.env: skipped: looks like a secret/);
  assert.match(text, /bin: skipped: binary/);
});
