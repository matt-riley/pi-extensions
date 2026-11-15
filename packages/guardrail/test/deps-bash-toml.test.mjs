import { test } from "node:test";
import assert from "node:assert/strict";

import { bashDependencyInstalls } from "../deps.mjs";

const names = (command) => bashDependencyInstalls(command).flatMap((hit) => hit.packages);
const none = (commands) => {
  for (const command of commands) assert.deepEqual(bashDependencyInstalls(command), [], command);
};

test("cargo add and cargo install name the crates they would fetch", () => {
  assert.deepEqual(names("cargo add serde"), ["serde"]);
  assert.deepEqual(names("cargo add serde@1 -F derive --dev"), ["serde@1"]);
  assert.deepEqual(names("cargo add --features derive serde tokio"), ["serde", "tokio"]);
  assert.deepEqual(names("cargo +nightly add serde"), ["serde"]);
  assert.deepEqual(names("cargo add --rename s serde"), ["serde"]);
  assert.deepEqual(names("cargo install ripgrep --locked"), ["ripgrep"]);
  assert.deepEqual(names("cargo install --version 14.0.0 ripgrep"), ["ripgrep"]);
  assert.deepEqual(bashDependencyInstalls("cargo install ripgrep"), [
    { manager: "cargo", verb: "install", packages: ["ripgrep"] },
  ]);
});

test("cargo from git names the crate, or the url when no crate is named", () => {
  assert.deepEqual(names("cargo add --git https://example.com/x.git"), [
    "https://example.com/x.git",
  ]);
  assert.deepEqual(names("cargo add x --git https://example.com/x.git"), ["x"]);
  assert.deepEqual(names("cargo install --git=https://example.com/x.git"), [
    "https://example.com/x.git",
  ]);
});

test("cargo with --path, and the commands that only build or restore, do not count", () => {
  none([
    "cargo add --path ../x",
    "cargo add x --path ../x",
    "cargo install --path .",
    "cargo install --list",
    "cargo build",
    "cargo build --release",
    "cargo fetch",
    "cargo check",
    "cargo test",
    "cargo run -- add serde",
    "cargo update",
    "cargo tree",
    "cargo remove serde",
  ]);
});

test("pip, pip3, python -m pip and uv pip install name the packages", () => {
  assert.deepEqual(names("pip install requests"), ["requests"]);
  assert.deepEqual(names("pip3 install -U requests rich"), ["requests", "rich"]);
  assert.deepEqual(names("pip3.12 install requests"), ["requests"]);
  assert.deepEqual(names("python3 -m pip install requests"), ["requests"]);
  assert.deepEqual(names("python -m pip install --user 'requests>=2'"), ["requests>=2"]);
  assert.deepEqual(names("uv pip install requests"), ["requests"]);
  assert.deepEqual(names("uv --quiet pip install requests"), ["requests"]);
  assert.deepEqual(names("pip install --index-url https://idx.example/simple requests"), [
    "requests",
  ]);
  assert.deepEqual(names("pip install --upgrade pip"), ["pip"]);
  assert.deepEqual(bashDependencyInstalls("uv pip install requests"), [
    { manager: "uv pip", verb: "install", packages: ["requests"] },
  ]);
});

test("pip installs from a file, or of this directory, do not count; named extras on top do", () => {
  none([
    "pip install -r requirements.txt",
    "pip install --requirement requirements.txt",
    "pip install -r req.txt -c constraints.txt",
    "pip install -e .",
    "pip install -e ./pkg",
    "pip install --editable ../pkg",
    "pip install .",
    "pip install ./dist/app.whl",
    "uv pip install -r requirements.txt",
    "uv pip sync requirements.txt",
    "pip list",
    "pip freeze",
    "pip uninstall requests",
    "pip show requests",
  ]);
  assert.deepEqual(names("pip install -r req.txt extra"), ["extra"]);
  assert.deepEqual(names("pip install -e git+https://example.com/x.git#egg=x"), [
    "git+https://example.com/x.git#egg=x",
  ]);
});

test("uv add and poetry add name the packages; the rest of uv and poetry does not count", () => {
  assert.deepEqual(names("uv add httpx"), ["httpx"]);
  assert.deepEqual(names("uv add --dev pytest"), ["pytest"]);
  assert.deepEqual(names("uv add --group lint ruff"), ["ruff"]);
  assert.deepEqual(names("poetry add requests"), ["requests"]);
  assert.deepEqual(names("poetry add -G dev pytest"), ["pytest"]);
  assert.deepEqual(names("poetry add 'httpx[http2]@^0.27'"), ["httpx[http2]@^0.27"]);
  assert.deepEqual(bashDependencyInstalls("uv add httpx"), [
    { manager: "uv", verb: "add", packages: ["httpx"] },
  ]);
  none([
    "uv add ../local",
    "uv add -r requirements.txt",
    "uv sync",
    "uv sync --frozen",
    "uv lock",
    "uv run pytest",
    "uv remove httpx",
    "poetry install",
    "poetry install --no-root",
    "poetry update",
    "poetry lock",
    "poetry run pytest",
    "poetry add ../local",
    "poetry remove requests",
  ]);
});

test("the new managers are found in chains, wrappers and nested shells", () => {
  assert.deepEqual(names("cd app && cargo build && cargo add serde"), ["serde"]);
  assert.deepEqual(names("sudo pip install requests"), ["requests"]);
  assert.deepEqual(names('bash -c "uv add httpx"'), ["httpx"]);
  assert.deepEqual(names("npm install left-pad && pip install requests"), ["left-pad", "requests"]);
  none(["echo cargo add serde", "grep 'pip install x' notes.md", "ls cargo"]);
});
