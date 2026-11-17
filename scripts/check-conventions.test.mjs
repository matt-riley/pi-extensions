import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  checkConventions,
  checkSkillReferences,
  controlByteErrors,
  fileSizeReport,
  harnessIsolationErrors,
  runtimeImports,
  scriptEntryErrors,
  sharedHelperErrors,
} from "./check-conventions.mjs";

test("a control byte in a text file is caught, and ordinary whitespace is not", () => {
  const root = mkdtempSync(path.join(tmpdir(), "conventions-"));
  try {
    mkdirSync(path.join(root, "packages"), { recursive: true });
    const BS = String.fromCharCode(8);
    writeFileSync(
      path.join(root, "packages", "broken.mjs"),
      `const word = /prefix${BS}(one|two)/;`,
    );
    writeFileSync(
      path.join(root, "packages", "fine.mjs"),
      "const word = /prefix\\b(one|two)/;\nconst lines = `a\nb`;\n",
    );
    writeFileSync(path.join(root, "packages", "binary.png"), Buffer.from([8, 8, 8]));
    const errors = controlByteErrors(root);
    assert.equal(errors.length, 1, "exactly the broken file");
    assert.match(errors[0], /packages\/broken\.mjs: control byte 0x08/);
    assert.match(errors[0], /match nothing/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a shared helper copied into a package is caught, and tests are exempt", () => {
  const root = mkdtempSync(path.join(tmpdir(), "shared-helpers-"));
  try {
    mkdirSync(path.join(root, "packages", "copy"), { recursive: true });
    mkdirSync(path.join(root, "packages", "copy", "test"), { recursive: true });
    writeFileSync(
      path.join(root, "packages", "copy", "judge.mjs"),
      'function usableNumber(raw) {\n  return Number(raw);\n}\nconst off = ["0", "false", "off", "no"].includes("x");\n',
    );
    writeFileSync(
      path.join(root, "packages", "copy", "good.mjs"),
      'import { usableNumber } from "../../shared/systemone.mjs";\nexport const n = usableNumber(1);\n',
    );
    writeFileSync(
      path.join(root, "packages", "copy", "test", "stub.test.mjs"),
      "function usableNumber(raw) {\n  return raw;\n}\n",
    );
    writeFileSync(
      path.join(root, "packages", "copy", "exec.ts"),
      "const exec = async (cmd, args, opts) => {\n  return pi.exec(cmd, args, { timeout: opts?.timeout ?? 10_000 });\n};\n",
    );
    const errors = sharedHelperErrors(root);
    assert.equal(errors.length, 3, "the definitions and the flag list, not the import");
    assert.match(
      errors[0],
      /packages\/copy\/exec\.ts: a local pi\.exec adapter belongs in shared\/exec\.mjs/,
    );
    assert.match(
      errors[1],
      /packages\/copy\/judge\.mjs: a local usableNumber belongs in shared\/systemone\.mjs/,
    );
    assert.match(
      errors[2],
      /packages\/copy\/judge\.mjs: a local off-flag list belongs in shared\/env-flag\.mjs/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an importable script must guard its entry point, and a mention is not a read", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "script-entry-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  const write = (name, source) => writeFileSync(path.join(root, "scripts", name), source);

  write(
    "unguarded.mjs",
    "export function parseArgs(argv) {\n  return argv;\n}\nconst args = parseArgs(process.argv.slice(2));\n",
  );
  assert.deepEqual(
    scriptEntryErrors(root).map((error) => error.split(":")[0]),
    ["scripts/unguarded.mjs"],
  );
  assert.match(scriptEntryErrors(root)[0], /guard the entry point on import\.meta\.url/);

  // The guard, argv inside a function, and a run-only script all pass.
  write(
    "unguarded.mjs",
    'import { pathToFileURL } from "node:url";\nexport function main(argv) {\n  return argv;\n}\nif (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main(process.argv.slice(2));\n',
  );
  write(
    "function-only.mjs",
    "export function parseArgs(argv) {\n  return process.argv.slice(2).concat(argv);\n}\n",
  );
  write("run-only.mjs", "const args = process.argv.slice(2);\nconsole.log(args);\n");
  assert.deepEqual(scriptEntryErrors(root), []);

  // A string or template that mentions argv is not a read; smoke-pi.mjs holds one.
  write(
    "mention.mjs",
    'export const fixture = "const args = process.argv.slice(2);";\nexport const block = `\n  process.argv[1]\n`;\n',
  );
  assert.deepEqual(scriptEntryErrors(root), []);

  // An exported value computed from argv still runs on import.
  write("exported-args.mjs", "export const args = process.argv.slice(2);\n");
  write("sample.test.mjs", "export const x = process.argv;\n");
  assert.deepEqual(
    scriptEntryErrors(root).map((error) => error.split(":")[0]),
    ["scripts/exported-args.mjs"],
    "a .test.mjs file is not a script entry",
  );
});

test("a terminal harness must isolate the pi config it runs against", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "harness-isolation-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, ".pi", "verify"), { recursive: true });
  const write = (name, source) => writeFileSync(path.join(root, ".pi", "verify", name), source);
  // The four assignments a real harness writes, then the session pi runs under.
  const ALL =
    'const env = ["HOME=" + fixture, "XDG_CONFIG_HOME=" + fixture, ' +
    '"PI_CODING_AGENT_DIR=" + agent, "PI_CODING_AGENT_SESSION_DIR=" + sessions];\n';
  const LAUNCH = 'tmux("new-session", "-d", "-s", "ui", "pi");\n';

  write("good.mjs", ALL + LAUNCH);
  assert.deepEqual(harnessIsolationErrors(root), []);

  // One missing variable is one finding, named so the fix is obvious.
  write("missing-home.mjs", ALL.replace('"HOME=" + fixture, ', "") + LAUNCH);
  assert.deepEqual(
    harnessIsolationErrors(root).map((error) => error.split(":")[0]),
    [".pi/verify/missing-home.mjs"],
  );
  assert.match(harnessIsolationErrors(root)[0], /without HOME=, so the run can reach/);

  // A comment naming the variables is not an assignment, a value built in a
  // template literal is, and a script that starts no session is out of scope.
  write(
    "prose-only.mjs",
    "// HOME= XDG_CONFIG_HOME= PI_CODING_AGENT_DIR= PI_CODING_AGENT_SESSION_DIR=\n" + LAUNCH,
  );
  write(
    "built.mjs",
    'const env = ["HOME=" + fixture, "XDG_CONFIG_HOME=" + fixture];\n' +
      "const dir = \x60PI_CODING_AGENT_DIR=\x24{agent}\x60;\n" +
      "const sessions = \x60PI_CODING_AGENT_SESSION_DIR=\x24{root}\x60;\n" +
      LAUNCH,
  );
  write("no-session.mjs", 'console.log("nothing to launch");\n');
  const files = harnessIsolationErrors(root).map((error) => error.split(":")[0]);
  assert.deepEqual(
    [...new Set(files)],
    [".pi/verify/missing-home.mjs", ".pi/verify/prose-only.mjs"],
    "a comment does not satisfy the rule, a built value does, and no session is out of scope",
  );
  assert.equal(
    files.filter((file) => file.endsWith("prose-only.mjs")).length,
    4,
    "one finding per missing variable, so the fix is a checklist",
  );
});
test("runtime imports distinguish erased types, mixed bindings, empty imports and dynamic imports", () => {
  const found = runtimeImports(
    `
import type { Foo } from "types-only";
import { type Bar } from "also-types";
import { type Foo, getAgentDir as dir } from "sdk";
import {} from "empty-import";
export {} from "empty-export";
export type { Baz } from "exported-types";
export { value } from "exported-runtime";
import("dynamic"); require("required"); import(variable);
`,
    "fixture.ts",
  );
  assert.deepEqual(
    found.map((item) => item.specifier),
    ["sdk", "empty-import", "empty-export", "exported-runtime", "dynamic", "required", null],
  );
  assert.deepEqual(found[0].names, ["getAgentDir"]);
});

test("conventions catch missing/duplicate registration, metadata, dependencies and runtime imports", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-conventions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "packages", "sample"), { recursive: true });
  const write = (name, data) =>
    writeFileSync(path.join(root, name), typeof data === "string" ? data : JSON.stringify(data));
  write("package.json", { pi: { extensions: ["./packages/sample/index.ts"] } });
  write("packages/sample/package.json", { name: "sample", description: "fixture", version: "1" });
  write("packages/sample/README.md", "fixture");
  write(
    "packages/sample/index.ts",
    'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"; import { Type } from "typebox";',
  );
  assert.deepEqual(checkConventions(root), []);
  write("package.json", {
    pi: { extensions: ["./packages/missing/index.ts", "./packages/missing/index.ts"] },
    dependencies: { foo: "1" },
  });
  write("packages/sample/package.json", {
    name: "sample",
    pi: {},
    optionalDependencies: { bad: "1" },
  });
  write(
    "packages/sample/index.ts",
    'import { getAgentDir } from "@earendil-works/pi-coding-agent"; import("external");',
  );
  const errors = checkConventions(root).join("\n");
  for (const expected of [
    "duplicate",
    "Unknown extension",
    "missing root registration",
    "missing description",
    "per-package pi",
    "dependencies",
    "optionalDependencies",
    "unapproved runtime import",
  ])
    assert.ok(errors.includes(expected), expected);
});

test("only the workbench entrypoint may import the approved host TUI widgets", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-tui-conventions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, "packages/workbench");
  mkdirSync(base, { recursive: true });
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ pi: { extensions: ["./packages/workbench/index.ts"] } }),
  );
  writeFileSync(
    path.join(base, "package.json"),
    JSON.stringify({ name: "workbench", description: "fixture" }),
  );
  writeFileSync(path.join(base, "README.md"), "fixture");
  writeFileSync(
    path.join(base, "index.ts"),
    'import {Input, SelectList, ScrollView, matchesKey, truncateToWidth} from "@earendil-works/pi-tui";',
  );
  assert.deepEqual(checkConventions(root), []);
  writeFileSync(path.join(base, "other.mjs"), 'import {Input} from "@earendil-works/pi-tui";');
  assert.match(checkConventions(root).join("\n"), /other.mjs: unapproved runtime import/);
  rmSync(path.join(base, "other.mjs"));
  for (const source of [
    'import {Editor} from "@earendil-works/pi-tui";',
    'import("@earendil-works/pi-tui");',
  ]) {
    writeFileSync(path.join(base, "index.ts"), source);
    assert.match(checkConventions(root).join("\n"), /index.ts: unapproved runtime import/);
  }
});

test("prompt skill references resolve only to valid repository-owned skills", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-skill-refs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(checkSkillReferences(root), [], "no prompts needs no skills");
  const skills = path.join(root, ".agents", "skills");
  mkdirSync(path.join(root, "prompts"), { recursive: true });
  mkdirSync(path.join(skills, "owned-review"), { recursive: true });
  writeFileSync(
    path.join(skills, "owned-review", "SKILL.md"),
    "---\nname: owned-review\ndescription: Review a change.\n---\n",
  );
  writeFileSync(path.join(root, "prompts", "ok.md"), "Use the `owned-review` skill.");
  assert.deepEqual(checkSkillReferences(root), [], "no personal library required");

  writeFileSync(path.join(root, "prompts", "bad.md"), "Use the missing-review skill.");
  const errors = checkSkillReferences(root);
  assert.equal(errors.length, 1, "missing skills fail even without a personal library");
  assert.match(errors[0], /prompts\/bad\.md: references the "missing-review" skill/);

  mkdirSync(path.join(root, "library", "missing-review"), { recursive: true });
  writeFileSync(
    path.join(root, "library", "missing-review", "SKILL.md"),
    "---\nname: missing-review\ndescription: Not owned.\n---\n",
  );
  assert.equal(
    checkSkillReferences(root).length,
    1,
    "unregistered libraries cannot satisfy dependencies",
  );

  mkdirSync(path.join(skills, "archived", "missing-review"), { recursive: true });
  writeFileSync(
    path.join(skills, "archived", "missing-review", "SKILL.md"),
    "---\nname: missing-review\ndescription: Retired.\n---\n",
  );
  assert.equal(checkSkillReferences(root).length, 1, "retired skills are not selectable");
  mkdirSync(path.join(skills, "missing-review"), { recursive: true });
  writeFileSync(path.join(skills, "missing-review", "SKILL.md"), "no frontmatter");
  assert.equal(
    checkSkillReferences(root).length,
    1,
    "a directory name alone is not a native skill",
  );
  writeFileSync(
    path.join(skills, "missing-review", "SKILL.md"),
    "---\nname: missing-review\n---\n",
  );
  assert.equal(checkSkillReferences(root).length, 1, "missing descriptions are not discoverable");
  writeFileSync(
    path.join(skills, "missing-review", "SKILL.md"),
    "---\nname: missing-review\ndescription: Now owned.\n---\n",
  );
  assert.deepEqual(checkSkillReferences(root), []);
});

test("a file past the size limit fails unless it is in the baseline", () => {
  const root = mkdtempSync(path.join(tmpdir(), "file-size-"));
  try {
    mkdirSync(path.join(root, "packages", "big"), { recursive: true });
    mkdirSync(path.join(root, "packages", "big", "test"), { recursive: true });
    const many = (lines) => "const x = 1;\n".repeat(lines);
    writeFileSync(path.join(root, "packages", "big", "new.mjs"), many(1001));
    writeFileSync(path.join(root, "packages", "big", "known.mjs"), many(1200));
    writeFileSync(path.join(root, "packages", "big", "test", "big.test.mjs"), many(2000));
    const baseline = new Set(["packages/big/known.mjs"]);
    const { errors, watch } = fileSizeReport(root, baseline);
    assert.equal(errors.length, 1, "only the file that is not in the baseline");
    assert.match(errors[0], /packages\/big\/new\.mjs: 1001 lines is past the 1000-line limit/);
    assert.deepEqual(
      watch.map((entry) => entry.relative),
      ["packages/big/known.mjs", "packages/big/new.mjs"],
      "watch list is longest first and skips tests",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a baselined file that fits under the limit again must leave the baseline", () => {
  const root = mkdtempSync(path.join(tmpdir(), "file-size-shrunk-"));
  try {
    mkdirSync(path.join(root, "packages", "big"), { recursive: true });
    writeFileSync(path.join(root, "packages", "big", "split.mjs"), "const x = 1;\n".repeat(900));
    const { errors, watch } = fileSizeReport(root, new Set(["packages/big/split.mjs"]));
    assert.equal(errors.length, 1);
    assert.match(errors[0], /now 900 lines, so remove it from FILE_SIZE_BASELINE/);
    assert.equal(watch.length, 1, "900 lines is still worth watching");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
