import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseScaffoldArgs, scaffoldRule } from "../scaffold.mjs";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const skillPath = path.join(repoRoot, ".agents/skills/lint-rules/SKILL.md");
const cliPath = fileURLToPath(new URL("../scaffold.mjs", import.meta.url));

const ALPHA = "Oxlint JS plugins are alpha and are not covered by semver.";
const NO_TYPES = "Type-aware rules cannot be written as JS plugins.";
const TSGOLINT = "oxlint-tsgolint";
const NO_MODULE_PLUGIN =
  "golangci-lint module plugins need a custom binary, so this scaffold does not use them.";

async function tempDir() {
  return mkdtemp(path.join(tmpdir(), "pi-quality-scaffold-"));
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeout ?? 150_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function goVersion() {
  return run("go", ["env", "GOVERSION"], { timeout: 10_000 }).then((result) => {
    if (result.code !== 0) return null;
    const match = /^go(\d+)\.(\d+)(?:\.(\d+))?/m.exec(result.stdout.trim());
    if (!match) return null;
    return match.slice(1).map((part) => Number(part));
  });
}

function versionAtLeast(version, want) {
  for (let index = 0; index < want.length; index += 1) {
    const got = version[index] ?? 0;
    if (got > want[index]) return true;
    if (got < want[index]) return false;
  }
  return true;
}

test("typescript scaffold writes a jsPlugins rule and a RuleTester fixture", async () => {
  const dir = await tempDir();
  try {
    const written = await scaffoldRule({ kind: "typescript", name: "no-example-smell", dir });
    assert.deepEqual(written.files.sort(), [
      ".oxlintrc.json",
      "package.json",
      "plugin.mjs",
      "plugin.test.mjs",
    ]);
    const manifest = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8"));
    assert.equal(manifest.type, "module");
    assert.equal(manifest.private, true);
    assert.equal(manifest.scripts.test, "node --test plugin.test.mjs");
    assert.equal(manifest.devDependencies.oxlint, "1.94.0");
    assert.equal(manifest.dependencies, undefined);
    const config = JSON.parse(await readFile(path.join(dir, ".oxlintrc.json"), "utf8"));
    assert.deepEqual(config.jsPlugins, ["./plugin.mjs"]);
    assert.equal(config.rules["local/no-example-smell"], "error");
    const plugin = await readFile(path.join(dir, "plugin.mjs"), "utf8");
    assert.match(plugin, /export default plugin/);
    assert.match(plugin, /name: "local"/);
    assert.match(plugin, /"no-example-smell": rule/);
    assert.match(plugin, /create\(context\)/);
    assert.match(plugin, /unexpected:/);
    assert.doesNotMatch(plugin, /^import /m);
    assert.doesNotMatch(plugin, /\bclass\b/);
    assert.ok(plugin.includes(ALPHA));
    assert.ok(plugin.includes(NO_TYPES));
    assert.ok(plugin.includes(TSGOLINT));
    const fixture = await readFile(path.join(dir, "plugin.test.mjs"), "utf8");
    assert.match(fixture, /from "node:test"/);
    assert.match(fixture, /from "oxlint\/plugins-dev"/);
    assert.match(fixture, /RuleTester\.describe = describe/);
    assert.match(fixture, /RuleTester\.it = it/);
    assert.match(fixture, /exampleSmell\(\);/);
    assert.match(fixture, /exampleSmell\(1\);/);
    assert.match(fixture, /messageId: "unexpected"/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("go-ruleguard scaffold writes a gocritic rule and a fixture", async () => {
  const dir = await tempDir();
  try {
    const written = await scaffoldRule({ kind: "go-ruleguard", name: "no-example-smell", dir });
    assert.deepEqual(written.files.sort(), [
      ".golangci.yml",
      "doc.go",
      "go.mod",
      "go.sum",
      "rules.go",
      "rules_test.go",
      "testdata/bad.go",
      "testdata/good.go",
    ]);
    const mod = await readFile(path.join(dir, "go.mod"), "utf8");
    assert.match(mod, /^module example\.com\/lint\/noexamplesmell\n/);
    assert.match(mod, /^go 1\.22\.0$/m);
    assert.match(mod, /github\.com\/quasilyte\/go-ruleguard v0\.4\.5/);
    assert.match(mod, /github\.com\/quasilyte\/go-ruleguard\/dsl v0\.3\.22/);
    const sum = await readFile(path.join(dir, "go.sum"), "utf8");
    assert.match(sum, /github\.com\/quasilyte\/go-ruleguard v0\.4\.5 h1:/);
    assert.match(sum, /github\.com\/quasilyte\/go-ruleguard\/dsl v0\.3\.22 h1:/);
    const rules = await readFile(path.join(dir, "rules.go"), "utf8");
    assert.match(rules, /^\/\/go:build ruleguard\n/);
    assert.match(rules, /github\.com\/quasilyte\/go-ruleguard\/dsl/);
    assert.match(rules, /func noExampleSmell\(m dsl\.Matcher\)/);
    assert.match(rules, /Match\(`exampleSmell\(\)`\)/);
    assert.ok(rules.includes(NO_MODULE_PLUGIN));
    const config = await readFile(path.join(dir, ".golangci.yml"), "utf8");
    assert.match(config, /^version: "2"$/m);
    assert.match(config, /default: none/);
    assert.match(config, /ruleguard/);
    assert.match(config, /\$\{base-path\}\/rules\.go/);
    assert.doesNotMatch(config, /^plugins:/m);
    assert.ok(config.includes(NO_MODULE_PLUGIN));
    const fixture = await readFile(path.join(dir, "rules_test.go"), "utf8");
    assert.match(fixture, /ruleguard\.NewEngine/);
    assert.match(fixture, /testdata\/bad\.go/);
    assert.match(fixture, /testdata\/good\.go/);
    const bad = await readFile(path.join(dir, "testdata/bad.go"), "utf8");
    const good = await readFile(path.join(dir, "testdata/good.go"), "utf8");
    assert.match(bad, /exampleSmell\(\)/);
    assert.match(good, /exampleSmell\(1\)/);
    assert.doesNotMatch(good, /exampleSmell\(\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("go-analysis scaffold writes an analyser tested with analysistest", async () => {
  const dir = await tempDir();
  try {
    const written = await scaffoldRule({ kind: "go-analysis", name: "no-example-smell", dir });
    assert.deepEqual(written.files.sort(), [
      "analyzer.go",
      "analyzer_test.go",
      "doc.go",
      "go.mod",
      "go.sum",
      "testdata/src/bad/bad.go",
      "testdata/src/good/good.go",
    ]);
    const mod = await readFile(path.join(dir, "go.mod"), "utf8");
    assert.match(mod, /^module example\.com\/lint\/noexamplesmell\n/);
    assert.match(mod, /^go 1\.26\.0$/m);
    assert.match(mod, /golang\.org\/x\/tools v0\.52\.0/);
    const sum = await readFile(path.join(dir, "go.sum"), "utf8");
    assert.match(sum, /golang\.org\/x\/tools v0\.52\.0 h1:/);
    const analyzer = await readFile(path.join(dir, "analyzer.go"), "utf8");
    assert.match(analyzer, /golang\.org\/x\/tools\/go\/analysis/);
    assert.match(analyzer, /go\/types/);
    assert.match(analyzer, /types\.Identical/);
    assert.ok(analyzer.includes(NO_MODULE_PLUGIN));
    const fixture = await readFile(path.join(dir, "analyzer_test.go"), "utf8");
    assert.match(fixture, /analysistest\.Run/);
    assert.match(fixture, /analysistest\.TestData\(\)/);
    const bad = await readFile(path.join(dir, "testdata/src/bad/bad.go"), "utf8");
    const good = await readFile(path.join(dir, "testdata/src/good/good.go"), "utf8");
    assert.match(bad, /func exampleSmell\(\) error/);
    assert.match(bad, /\/\/ want `exampleSmell returns error`/);
    assert.match(good, /func exampleSmell\(\) int/);
    assert.match(good, /exampleSmell\(\)/);
    assert.doesNotMatch(good, /\/\/ want /);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rule names become safe Go identifiers and reject unsafe input", async () => {
  const keyword = await tempDir();
  try {
    await scaffoldRule({ kind: "go-analysis", name: "func", dir: keyword });
    const analyzer = await readFile(path.join(keyword, "analyzer.go"), "utf8");
    assert.match(analyzer, /package rulefunc/);
    assert.match(analyzer, /Name: "rulefunc"/);
  } finally {
    await rm(keyword, { recursive: true, force: true });
  }
  for (const name of ["", "No-Foo", "no_foo", "../x", "a/b", "-no", "no-", "no--foo", "1abc"]) {
    const dir = await tempDir();
    try {
      await assert.rejects(
        async () => scaffoldRule({ kind: "typescript", name, dir }),
        /kebab-case/,
      );
      assert.deepEqual(await listSafe(dir), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const dir = await tempDir();
  try {
    await assert.rejects(
      async () => scaffoldRule({ kind: "rust", name: "no-example-smell", dir }),
      /unknown/i,
    );
    await assert.rejects(
      async () => scaffoldRule({ kind: "typescript", name: "no-example-smell" }),
      /dir/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a second write refuses to replace a rule that already exists", async () => {
  const dir = await tempDir();
  try {
    await scaffoldRule({ kind: "typescript", name: "no-example-smell", dir });
    const marker = "marker that must survive";
    await writeFile(path.join(dir, "plugin.mjs"), marker);
    await assert.rejects(
      async () => scaffoldRule({ kind: "typescript", name: "no-example-smell", dir }),
      /already exists/,
    );
    assert.equal(await readFile(path.join(dir, "plugin.mjs"), "utf8"), marker);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the CLI is the one-step entry the skill names", async () => {
  assert.deepEqual(parseScaffoldArgs(["go-analysis", "no-example-smell", "--dir", "lint"]), {
    kind: "go-analysis",
    name: "no-example-smell",
    dir: "lint",
  });
  assert.throws(
    () => parseScaffoldArgs(["typescript", "no-example-smell", "--out", "x"]),
    /Unknown argument/,
  );
  const parent = await tempDir();
  try {
    const missing = await run(process.execPath, [cliPath], { cwd: parent, timeout: 10_000 });
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /Usage: node packages\/quality\/scaffold\.mjs/);
    const relative = await run(
      process.execPath,
      [cliPath, "typescript", "no-example-smell", "--dir", "out"],
      { cwd: parent, timeout: 10_000 },
    );
    assert.equal(relative.code, 0, relative.stderr);
    assert.match(relative.stdout, /plugin\.test\.mjs/);
    const plugin = await readFile(path.join(parent, "out", "plugin.mjs"), "utf8");
    assert.ok(plugin.includes(ALPHA));
    const bad = await run(process.execPath, [cliPath, "typescript", "Bad", "--dir", "bad"], {
      cwd: parent,
      timeout: 10_000,
    });
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /kebab-case/);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("the lint-rules skill points at the scaffolds", async () => {
  const skill = await readFile(skillPath, "utf8");
  for (const command of [
    "node packages/quality/scaffold.mjs typescript <rule-name> --dir <target>",
    "node packages/quality/scaffold.mjs go-ruleguard <rule-name> --dir <target>",
    "node packages/quality/scaffold.mjs go-analysis <rule-name> --dir <target>",
  ])
    assert.ok(skill.includes(command), command);
  assert.match(skill, /disallowed-methods/);
  assert.match(skill, /selene/);
  assert.doesNotMatch(skill, /from "oxlint\/plugins-dev"/);
  assert.doesNotMatch(skill, /analysistest\.Run/);
});

test("runs the typescript fixture when the pinned oxlint is resolvable", async (t) => {
  const found = typescriptToolchain();
  if (found.skip) {
    t.skip(found.skip);
    return;
  }
  const dir = await tempDir();
  try {
    await scaffoldRule({ kind: "typescript", name: "no-example-smell", dir });
    const result = await run(process.execPath, ["--test", "plugin.test.mjs"], {
      cwd: dir,
      timeout: 60_000,
      env: { ...process.env, NODE_PATH: found.nodePath },
    });
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runs the ruleguard fixture when Go is available outside this repo's CI", async (t) => {
  const reason = await goSkipReason("1.22.0", "ruleguard");
  if (reason) {
    t.skip(reason);
    return;
  }
  const dir = await tempDir();
  try {
    await scaffoldRule({ kind: "go-ruleguard", name: "no-example-smell", dir });
    const result = await run("go", ["test", "."], { cwd: dir, timeout: 180_000 });
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runs the go/analysis fixture when Go 1.26 is available outside this repo's CI", async (t) => {
  const reason = await goSkipReason(
    "1.26.0",
    "go/analysis",
    ", which golang.org/x/tools v0.52.0 requires",
  );
  if (reason) {
    t.skip(reason);
    return;
  }
  const dir = await tempDir();
  try {
    await scaffoldRule({ kind: "go-analysis", name: "no-example-smell", dir });
    const result = await run("go", ["test", "."], { cwd: dir, timeout: 180_000 });
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function typescriptToolchain() {
  let version = null;
  let nodePath = "";
  try {
    const resolved = createRequire(path.join(repoRoot, "package.json")).resolve(
      "oxlint/package.json",
    );
    version = JSON.parse(readFileSync(resolved, "utf8")).version;
    nodePath = path.dirname(path.dirname(resolved));
  } catch {
    version = null;
  }
  if (version !== "1.94.0")
    return {
      skip: `oxlint/plugins-dev at 1.94.0 is not installed (found ${version ?? "none"}). JS plugins are not covered by semver, so the typescript fixture was not executed.`,
    };
  return { nodePath };
}

async function goSkipReason(minimum, label, because = "") {
  if (process.env.GITHUB_ACTIONS === "true")
    return `This repository's CI does not install Go. The ${label} fixture was not executed.`;
  const version = await goVersion();
  if (!version) return `go is not on PATH. The ${label} fixture was not executed.`;
  const want = minimum.split(".").map((part) => Number(part));
  if (!versionAtLeast(version, want)) {
    const found = version.join(".");
    return `go ${found} is older than ${minimum}${because}. The ${label} fixture was not executed.`;
  }
  return "";
}

function listSafe(dir) {
  return readdir(dir);
}
