import { test } from "node:test";
import assert from "node:assert/strict";

import { bashDependencyInstalls } from "../deps.mjs";

const names = (command) => bashDependencyInstalls(command).flatMap((hit) => hit.packages);

test("npm, pnpm, yarn and bun adds name the packages they would install", () => {
  for (const command of [
    "npm install left-pad",
    "npm i left-pad",
    "npm add left-pad",
    "pnpm add left-pad",
    "pnpm install left-pad",
    "pnpm i left-pad",
    "yarn add left-pad",
    "bun add left-pad",
    "bun install left-pad",
    "bun i left-pad",
  ]) {
    assert.deepEqual(names(command), ["left-pad"], command);
  }
});

test("flags, versions and several packages are read as written", () => {
  assert.deepEqual(names("npm install --save-dev -E left-pad@1.3.0 @scope/pkg"), [
    "left-pad@1.3.0",
    "@scope/pkg",
  ]);
  assert.deepEqual(names("pnpm --filter web add zod"), ["zod"]);
  assert.deepEqual(names("pnpm add -w -D zod"), ["zod"]);
  assert.deepEqual(names("npm install --prefix ./app left-pad"), ["left-pad"]);
  assert.deepEqual(names("yarn --cwd app add left-pad"), ["left-pad"]);
  assert.deepEqual(names("bun add --cwd app left-pad"), ["left-pad"]);
  assert.deepEqual(names("npm install --registry=https://r.example left-pad"), ["left-pad"]);
});

test("a plain install or ci only restores the lockfile and does not count", () => {
  for (const command of [
    "npm install",
    "npm i",
    "npm ci",
    "npm install --no-audit",
    "npm install --prefix ./app",
    "npm install -w web",
    "pnpm install",
    "pnpm install --frozen-lockfile",
    "pnpm --filter web install",
    "yarn",
    "yarn install --frozen-lockfile",
    "bun install",
    "bun install --frozen-lockfile",
    "rm -rf node_modules && npm install",
  ]) {
    assert.deepEqual(bashDependencyInstalls(command), [], command);
  }
});

test("other subcommands and look-alike words do not count", () => {
  for (const command of [
    "npm run install-hooks",
    "npm test left-pad",
    "npm view left-pad",
    "npm uninstall left-pad",
    "pnpm run add",
    "echo npm install left-pad",
    'grep "npm install left-pad" notes.md',
    "git commit -m 'bun add zod'",
    "ls",
  ]) {
    assert.deepEqual(bashDependencyInstalls(command), [], command);
  }
});

test("go get with arguments and go install of a remote package count; local builds do not", () => {
  assert.deepEqual(names("go get github.com/pkg/errors@v0.9.1"), ["github.com/pkg/errors@v0.9.1"]);
  assert.deepEqual(names("go get -u ./..."), ["./..."]);
  assert.deepEqual(names("go install golang.org/x/tools/cmd/stringer@latest"), [
    "golang.org/x/tools/cmd/stringer@latest",
  ]);
  for (const command of [
    "go install",
    "go install .",
    "go install ./cmd/tool",
    "go install ./...",
    "go build ./...",
    "go test ./...",
    "go mod tidy",
    "go get",
  ]) {
    assert.deepEqual(bashDependencyInstalls(command), [], command);
  }
});

test("each segment of a chain is checked, and wrappers and nested shells are looked through", () => {
  assert.deepEqual(names("cd app && npm install left-pad && npm test"), ["left-pad"]);
  assert.deepEqual(names("npm ci; pnpm add zod | cat"), ["zod"]);
  assert.deepEqual(names("sudo npm install -g left-pad"), ["left-pad"]);
  assert.deepEqual(names("env CI=1 npm install left-pad"), ["left-pad"]);
  assert.deepEqual(names('bash -c "npm install left-pad"'), ["left-pad"]);
  assert.deepEqual(names("npm install left-pad && go get example.com/m"), [
    "left-pad",
    "example.com/m",
  ]);
});

test("the hit says which manager and verb it saw", () => {
  assert.deepEqual(bashDependencyInstalls("pnpm add zod"), [
    { manager: "pnpm", verb: "add", packages: ["zod"] },
  ]);
  assert.deepEqual(bashDependencyInstalls("go install example.com/x@v1"), [
    { manager: "go", verb: "install", packages: ["example.com/x@v1"] },
  ]);
});

test("empty, missing and non-string input gives no hits", () => {
  assert.deepEqual(bashDependencyInstalls(""), []);
  assert.deepEqual(bashDependencyInstalls(undefined), []);
  assert.deepEqual(bashDependencyInstalls({ not: "a command" }), []);
});
