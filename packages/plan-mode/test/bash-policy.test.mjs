import { test } from "node:test";
import assert from "node:assert/strict";
import { blockedBashCommand, blockedBashSegment } from "../bash-policy.mjs";

test("allows read-only inspection commands", () => {
  for (const cmd of [
    "ls -la",
    "cat package.json",
    "grep -rn plan_mode src",
    "rg \"TODO\" .",
    "find src -name '*.ts'",
    "head -50 README.md",
    "tail -20 logs/server.log",
    "wc -l src/index.ts",
    "sort -u file.txt",
    "awk '{print $1}' file.txt",
    "cd src && pwd",
  ]) {
    assert.equal(blockedBashCommand(cmd), undefined, `should allow: ${cmd}`);
  }
});

test("blocks mutating first tokens", () => {
  for (const cmd of [
    "rm -rf node_modules",
    "mv a b",
    "cp -r src dst",
    "touch file",
    "chmod +x script.sh",
    "sudo whoami",
    "kill -9 1234",
    "curl https://example.com -o out.html",
    "vim package.json",
    "sed -i s/x/y/ file",
    "tee out.txt",
    "make build",
    "docker build .",
  ]) {
    assert.ok(blockedBashCommand(cmd), `should block: ${cmd}`);
  }
});

test("blocks redirects", () => {
  for (const cmd of ["echo hi > file", "ls >> log.txt", "2> err", "cat < input"]) {
    assert.ok(blockedBashCommand(cmd), `should block: ${cmd}`);
  }
});

test("git: allows read-only, blocks mutating subcommands", () => {
  assert.equal(blockedBashCommand("git status"), undefined);
  assert.equal(blockedBashCommand("git log -p -3"), undefined);
  assert.equal(blockedBashCommand("git diff HEAD~1"), undefined);
  assert.equal(blockedBashCommand("git show --stat HEAD"), undefined);
  assert.equal(blockedBashCommand("git -C src rev-parse HEAD"), undefined);
  for (const cmd of [
    "git commit -m x",
    "git push origin main",
    "git checkout -b feature",
    "git add .",
    "git reset --hard",
    "git merge main",
  ]) {
    assert.ok(blockedBashCommand(cmd), `should block: ${cmd}`);
  }
});

test("package managers: allows checks, blocks installs and bare invocation", () => {
  assert.equal(blockedBashCommand("npm test"), undefined);
  assert.equal(blockedBashCommand("npm run typecheck"), undefined);
  assert.equal(blockedBashCommand("bun test"), undefined);
  assert.equal(blockedBashCommand("cargo test"), undefined);
  assert.equal(blockedBashCommand("go test ./..."), undefined);
  assert.equal(blockedBashCommand("go vet ./..."), undefined);
  for (const cmd of [
    "npm install",
    "npm i foo",
    "npm ci",
    "npm exec tsx",
    "pnpm add lodash",
    "bun add x",
    "yarn",
    "yarn add x",
    "cargo add serde",
    "cargo run",
    "go get x",
    "go run main.go",
  ]) {
    assert.ok(blockedBashCommand(cmd), `should block: ${cmd}`);
  }
});

test("blocks a chain when any segment is unsafe", () => {
  assert.equal(blockedBashCommand("cd src && npm test"), undefined);
  assert.equal(blockedBashCommand("git log -p | head -50"), undefined);
  assert.ok(blockedBashCommand("cd src && rm -rf out"));
  assert.ok(blockedBashCommand("npm test && git push"));
  assert.ok(blockedBashCommand("ls -la; touch x"));
});

test("empty and whitespace input is allowed", () => {
  assert.equal(blockedBashCommand(""), undefined);
  assert.equal(blockedBashSegment("   "), undefined);
  assert.equal(blockedBashCommand(undefined), undefined);
});
