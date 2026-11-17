// The blinded A/B eval: name and prompt checks, case loading, and one full run
// against a stand-in pi binary, so no model is called.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { BANNED_WORDS, bannedWords, promptProblems, sanitize } from "./workflow-eval/sanitize.mjs";
import { loadCases, openedFiles, runVariantEval } from "./workflow-eval/variants.mjs";

const temps = [];
after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});
async function scratch(prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
async function put(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

test("sanitize rejects every banned word and keeps project-shaped names", () => {
  for (const name of [
    "eval-cache",
    "unit-tests",
    "TestFixtures",
    "judge_pass",
    "judged-run",
    "scoring",
    "rubric",
    "score2",
    "candidate-b",
    "benchmarks",
    "my evaluation",
  ])
    assert.throws(() => sanitize(name), /names the measurement/, name);
  for (const word of BANNED_WORDS)
    assert.throws(() => sanitize(`x-${word}`), /names the measurement/, word);
  assert.equal(sanitize("Cache Warmup"), "cache-warmup");
  assert.equal(sanitize("latest_release"), "latest-release");
  assert.equal(sanitize("contest-entry"), "contest-entry");
  assert.throws(() => sanitize("---"), /no usable name/);
});

test("case prompts may not name the measurement or ask which skills were used", () => {
  assert.deepEqual(promptProblems("Make the cache warm up before the first request."), []);
  assert.deepEqual(promptProblems("Fix the bug and run the tests."), ['names "test"']);
  assert.deepEqual(promptProblems("Fix it, then tell me which skills you used."), [
    "asks which skills were used",
  ]);
  assert.deepEqual(bannedWords("a Benchmark for the Judge"), ["judge", "benchmark"]);
});

test("loading cases refuses giveaway names, prompts and fixture paths, and the run cap", async () => {
  const make = async (files) => {
    const dir = await scratch("flow-cases-");
    for (const [file, text] of Object.entries(files)) await put(path.join(dir, file), text);
    return dir;
  };
  await assert.rejects(
    loadCases(await make({ "scoring-case/prompt.md": "Fix the cache." })),
    /names the measurement/,
  );
  await assert.rejects(
    loadCases(await make({ "cache/prompt.md": "Fix the cache and judge it." })),
    /names "judge"/,
  );
  await assert.rejects(
    loadCases(
      await make({ "cache/prompt.md": "Fix the cache.", "cache/fixture/cache.test.mjs": "" }),
    ),
    /cache\.test\.mjs names the measurement/,
  );
  const five = Object.fromEntries(
    ["a", "b", "c", "d", "e"].map((name) => [`${name}/prompt.md`, "Fix the cache."]),
  );
  await assert.rejects(loadCases(await make(five)), /5 cases need 10 runs; the cap is 8/);
});

test("opened files are relative to the workspace or the agent directory", () => {
  const events = [
    { type: "tool_execution_start", toolName: "read", args: { path: "src/cache.mjs" } },
    { type: "tool_execution_start", toolName: "read", args: { path: "/agent/skills/x/SKILL.md" } },
    { type: "tool_execution_start", toolName: "read", args: { path: "src/cache.mjs" } },
    { type: "tool_execution_start", toolName: "bash", args: { command: "cat notes.md" } },
  ];
  assert.deepEqual(openedFiles(events, { workspace: "/work/cache", agentDir: "/agent" }), [
    "src/cache.mjs",
    "skills/x/SKILL.md",
  ]);
});

// A stand-in for pi: records what it was given, "reads" the first skill it was
// passed and the fixture's notes, and writes done.txt only when the appended
// system prompt says so. Prints the same JSON events pi's json mode prints.
const FAKE_PI = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const at = (flag) => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
const system = at("--append-system-prompt") ?? "";
const skill = at("--skill");
const emit = (event) => console.log(JSON.stringify(event));
process.stderr.write(JSON.stringify({ cwd: process.cwd(), args, agentDir: process.env.PI_CODING_AGENT_DIR }));
if (skill) emit({ type: "tool_execution_start", toolName: "read", args: { path: skill + "/SKILL.md" } });
emit({ type: "tool_execution_start", toolName: "read", args: { path: "notes.md" } });
if (system.includes("WRITE")) fs.writeFileSync("done.txt", "ok");
emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "answer from " + (system || "nothing") }], usage: { totalTokens: 10, cost: { total: 0.01 } } } });
emit({ type: "turn_end" });
`;

test("a full A/B run blinds the workspace, grades from the transcript and shuffles for the judge", async () => {
  const root = await scratch("flow-run-");
  const bin = path.join(root, "bin", "pi");
  await put(bin, FAKE_PI);
  await chmod(bin, 0o755);
  await put(path.join(root, "a", "SYSTEM.md"), "Plain.");
  await put(path.join(root, "b", "SYSTEM.md"), "WRITE the file.");
  await put(path.join(root, "b", "skills", "cache-warmup", "SKILL.md"), "---\nname: x\n---\n");
  for (const name of ["cache", "router"]) {
    await put(path.join(root, "cases", name, "prompt.md"), `Warm the ${name} up.`);
    await put(path.join(root, "cases", name, "fixture", "notes.md"), "notes");
    await put(path.join(root, "cases", name, "accept.sh"), "test -f done.txt\n");
    await put(
      path.join(root, "cases", name, "case.json"),
      JSON.stringify({ split: "development", expectRead: ["skills/cache-warmup/SKILL.md"] }),
    );
  }
  const output = path.join(root, "out");
  const run = () =>
    runVariantEval({
      variantA: path.join(root, "a"),
      variantB: path.join(root, "b"),
      casesDir: path.join(root, "cases"),
      output,
      model: { provider: "fixture", model: "m", credential: { type: "api_key", key: "k" } },
      bin,
      pick: () => 1,
    });
  const { results, reportedCost } = await run();

  assert.deepEqual(
    results.map((result) => `${result.case}-${result.variant}`),
    ["cache-a", "cache-b", "router-b", "router-a"],
  );
  for (const result of results) {
    assert.equal(result.accepted, result.variant === "b");
    assert.equal(result.followed, result.variant === "b");
    assert.ok(result.opened.includes("notes.md"));
  }
  assert.ok(Math.abs(reportedCost - 0.04) < 1e-9);

  for (const result of results) {
    const seen = await readFile(
      path.join(output, `${result.case}-${result.variant}-stderr.txt`),
      "utf8",
    );
    const { cwd, args } = JSON.parse(seen);
    assert.equal(path.basename(cwd), result.case);
    assert.deepEqual(bannedWords([cwd, ...args].join(" ")), [], seen);
  }

  const key = JSON.parse(await readFile(path.join(output, "blind-key.json"), "utf8"));
  assert.deepEqual(key, { cache: ["b", "a"], router: ["b", "a"] });
  const blind = await readFile(path.join(output, "blind", "cache.md"), "utf8");
  assert.match(
    blind,
    /## Response 1\n\nanswer from WRITE the file\.\n\n## Response 2\n\nanswer from Plain\./,
  );
  assert.doesNotMatch(blind, /variant|\bfixture\b|"a"|"b"/);

  await assert.rejects(run(), /EEXIST/); // No rerun into the same output.
});
