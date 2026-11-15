import { test } from "node:test";
import assert from "node:assert/strict";

import { dependencyEditPath, fileDependencyChanges } from "../deps.mjs";

const write = (path, content, before) =>
  fileDependencyChanges({ path, input: { content }, before });
const rawEdit = (path, before, oldText, newText) =>
  fileDependencyChanges({ path, input: { path, edits: [{ oldText, newText }] }, before });
// An edit that does not match the file would pass every "does not trigger" test for free.
const edit = (path, before, oldText, newText) => {
  assert.ok(before.includes(oldText), `fixture drifted: ${JSON.stringify(oldText)} is not in it`);
  return rawEdit(path, before, oldText, newText);
};
const summary = (changes) =>
  changes.map((c) => `${c.section}: ${c.name} ${c.from ?? "-"} -> ${c.to}`);

const cargo = `[package]
name = "app"
version = "0.1.0"
edition = "2021"

[features]
fast = ["serde/derive"]

[dependencies]
serde = { version = "1", features = ["derive"] }
anyhow = "1"

[dev-dependencies]
tempfile = "3"

[build-dependencies]
cc = "1"

[target.'cfg(unix)'.dependencies]
libc = "0.2"

[[bin]]
name = "app"
path = "src/main.rs"

[workspace.dependencies]
tokio = "1"
`;

test("Cargo.toml: a new crate in each dependency table is a change", () => {
  const cases = [
    ["[dependencies]", "dependencies"],
    ["[dev-dependencies]", "dev-dependencies"],
    ["[build-dependencies]", "build-dependencies"],
    ["[target.'cfg(unix)'.dependencies]", "target.cfg(unix).dependencies"],
    ["[workspace.dependencies]", "workspace.dependencies"],
  ];
  for (const [header, section] of cases) {
    const after = cargo.replace(header, `${header}\nleft-pad = "1.3"`);
    assert.deepEqual(
      summary(write("/r/Cargo.toml", after, cargo)),
      [`${section}: left-pad - -> 1.3`],
      section,
    );
  }
});

test("Cargo.toml: dotted keys, inline tables and sub-tables are read", () => {
  const dotted = cargo.replace('anyhow = "1"', 'anyhow = "1"\nreqwest.version = "0.12"');
  assert.deepEqual(summary(write("Cargo.toml", dotted, cargo)), [
    "dependencies: reqwest - -> 0.12",
  ]);
  const subTable = cargo + '\n[dependencies.clap]\nversion = "4"\n';
  assert.deepEqual(summary(write("Cargo.toml", subTable, cargo)), ["dependencies: clap - -> 4"]);
  const git = cargo.replace(
    'anyhow = "1"',
    'anyhow = "1"\nfoo = { git = "https://example.com/foo", rev = "abc" }',
  );
  assert.deepEqual(summary(write("Cargo.toml", git, cargo)), [
    "dependencies: foo - -> git https://example.com/foo rev abc",
  ]);
  const path = cargo.replace('anyhow = "1"', 'anyhow = "1"\nlocal = { path = "../local" }');
  assert.deepEqual(summary(write("Cargo.toml", path, cargo)), [
    "dependencies: local - -> path ../local",
  ]);
});

test("Cargo.toml: a new version or source is a change; features alone are not", () => {
  assert.deepEqual(summary(edit("Cargo.toml", cargo, 'anyhow = "1"', 'anyhow = "2"')), [
    "dependencies: anyhow 1 -> 2",
  ]);
  assert.deepEqual(
    edit("Cargo.toml", cargo, 'features = ["derive"]', 'features = ["derive", "rc"]'),
    [],
  );
  assert.deepEqual(
    summary(edit("Cargo.toml", cargo, 'version = "1", features', 'version = "1.0.200", features')),
    ["dependencies: serde 1 -> 1.0.200"],
  );
});

test("Cargo.toml: package metadata, features, bins and removals never trigger", () => {
  assert.deepEqual(edit("Cargo.toml", cargo, 'version = "0.1.0"', 'version = "0.2.0"'), []);
  assert.deepEqual(edit("Cargo.toml", cargo, 'edition = "2021"', 'edition = "2024"'), []);
  assert.deepEqual(
    edit("Cargo.toml", cargo, 'fast = ["serde/derive"]', 'fast = ["serde/derive", "x"]'),
    [],
  );
  assert.deepEqual(edit("Cargo.toml", cargo, 'path = "src/main.rs"', 'path = "src/app.rs"'), []);
  assert.deepEqual(edit("Cargo.toml", cargo, 'anyhow = "1"\n', ""), []);
});

test("Cargo.toml: a new file lists every dependency", () => {
  const content = '[dependencies]\na = "1"\nb = { version = "2" }\n';
  assert.deepEqual(summary(write("Cargo.toml", content, undefined)), [
    "dependencies: a - -> 1",
    "dependencies: b - -> 2",
  ]);
});

const pyproject = `[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[project]
name = "app"
version = "0.1.0"
description = """
A multi-line
description."""
requires-python = ">=3.11"
dependencies = [
  "requests>=2.31",
  "rich",
]

[project.optional-dependencies]
dev = ["pytest>=8"]

[dependency-groups]
lint = ["ruff>=0.5", { include-group = "dev" }]

[tool.poetry.dependencies]
python = "^3.11"
httpx = "^0.27"

[tool.poetry.group.test.dependencies]
pytest-cov = { version = "^5", extras = ["toml"] }

[tool.ruff]
line-length = 100
`;

test("pyproject.toml: a new requirement in each place is a change", () => {
  const cases = [
    ['"rich",', '"rich",\n  "left-pad>=1",', "project.dependencies"],
    [
      'dev = ["pytest>=8"]',
      'dev = ["pytest>=8", "left-pad>=1"]',
      "project.optional-dependencies.dev",
    ],
    ['lint = ["ruff>=0.5",', 'lint = ["left-pad>=1", "ruff>=0.5",', "dependency-groups.lint"],
    ['httpx = "^0.27"', 'httpx = "^0.27"\nleft-pad = "^1"', "tool.poetry.dependencies"],
    [
      'pytest-cov = { version = "^5", extras = ["toml"] }',
      'pytest-cov = { version = "^5", extras = ["toml"] }\nleft-pad = "^1"',
      "tool.poetry.group.test.dependencies",
    ],
  ];
  for (const [oldText, newText, section] of cases) {
    const found = edit("pyproject.toml", pyproject, oldText, newText);
    assert.equal(found.length, 1, section);
    assert.equal(found[0].section, section);
    assert.equal(found[0].name, "left-pad");
  }
});

test("pyproject.toml: names are read out of requirement strings", () => {
  const added = (line) =>
    summary(edit("pyproject.toml", pyproject, '"rich",', `"rich",\n  ${JSON.stringify(line)},`));
  assert.deepEqual(added("Django[argon2]>=4.2; python_version>='3.10'"), [
    "project.dependencies: Django - -> [argon2]>=4.2; python_version>='3.10'",
  ]);
  assert.deepEqual(added("pkg @ https://example.com/pkg.whl"), [
    "project.dependencies: pkg - -> @ https://example.com/pkg.whl",
  ]);
  assert.deepEqual(added("bare"), ["project.dependencies: bare - -> *"]);
});

test("pyproject.toml: a new range is a change; poetry python and tool tables are not", () => {
  assert.deepEqual(
    summary(edit("pyproject.toml", pyproject, '"requests>=2.31"', '"requests>=2.32"')),
    ["project.dependencies: requests >=2.31 -> >=2.32"],
  );
  assert.deepEqual(edit("pyproject.toml", pyproject, 'python = "^3.11"', 'python = "^3.12"'), []);
  assert.deepEqual(edit("pyproject.toml", pyproject, "line-length = 100", "line-length = 88"), []);
  assert.deepEqual(edit("pyproject.toml", pyproject, 'version = "0.1.0"', 'version = "0.2.0"'), []);
  assert.deepEqual(
    edit("pyproject.toml", pyproject, 'requires = ["hatchling"]', 'requires = ["hatchling", "x"]'),
    [],
  );
  assert.deepEqual(edit("pyproject.toml", pyproject, '  "rich",\n', ""), []);
  assert.deepEqual(edit("pyproject.toml", pyproject, '">=3.11"', '">=3.12"'), []);
});

test("pyproject.toml: poetry tables with a version, git or path are labelled", () => {
  const found = write(
    "pyproject.toml",
    pyproject.replace(
      'httpx = "^0.27"',
      'httpx = "^0.27"\ngitpkg = { git = "https://example.com/g.git", branch = "main" }',
    ),
    pyproject,
  );
  assert.deepEqual(summary(found), [
    "tool.poetry.dependencies: gitpkg - -> git https://example.com/g.git branch main",
  ]);
});

test("a toml file that cannot be read is not judged after an edit, and counts as empty before", () => {
  assert.deepEqual(edit("Cargo.toml", cargo, 'anyhow = "1"', 'anyhow = "1" extra'), []);
  assert.deepEqual(edit("pyproject.toml", pyproject, '"rich",', '"rich", ['), []);
  const fixed = '[dependencies]\na = "1"\n';
  assert.deepEqual(summary(write("Cargo.toml", fixed, "[dependencies\na = ")), [
    "dependencies: a - -> 1",
  ]);
  assert.deepEqual(rawEdit("Cargo.toml", cargo, "not in the file", "x"), []);
  assert.deepEqual(rawEdit("Cargo.toml", undefined, "a", "b"), []);
});

test("only Cargo.toml and pyproject.toml by those names, outside vendored folders", () => {
  const content = '[dependencies]\na = "1"\n';
  assert.equal(write("/r/crates/x/Cargo.toml", content, "").length, 1);
  assert.equal(write("/r/node_modules/x/Cargo.toml", content, "").length, 0);
  assert.equal(write("/r/Cargo.toml.bak", content, "").length, 0);
  assert.equal(write("/r/cargo.toml", content, "").length, 0);
  assert.equal(write("/r/Cargo.lock", content, "").length, 0);
  assert.equal(dependencyEditPath("edit", { path: "a/Cargo.toml" }), "a/Cargo.toml");
  assert.equal(dependencyEditPath("write", { path: "pyproject.toml" }), "pyproject.toml");
  assert.equal(dependencyEditPath("write", { path: "Cargo.lock" }), null);
});
