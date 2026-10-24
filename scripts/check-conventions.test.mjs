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
  runtimeImports,
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
    const errors = sharedHelperErrors(root);
    assert.equal(errors.length, 2, "the definition and the flag list, not the import");
    assert.match(
      errors[0],
      /packages\/copy\/judge\.mjs: a local usableNumber belongs in shared\/systemone\.mjs/,
    );
    assert.match(
      errors[1],
      /packages\/copy\/judge\.mjs: a local off-flag list belongs in shared\/env-flag\.mjs/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
