import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validateRequest } from "../../../shared/systemone-request.mjs";
import { isVerifyCommand } from "../gate.mjs";
import { resolveScopedChecks } from "../scoped.mjs";

const repo = {
  verify: false,
  golangci: false,
  goModule: {},
  tsconfigs: {},
  stylua: [],
  selene: [],
};

const checks = (files, extra = {}) =>
  resolveScopedChecks({ files, repo: { ...repo, ...extra }, env: {} });

test("a changed Go file maps to go test on that package, not the whole repo", async () => {
  const commands = await resolveScopedChecks({
    files: ["pkg/foo/a.go"],
    repo,
    env: {},
  });
  assert.deepEqual(commands, ["go test ./pkg/foo"]);
});

test("Go packages under one parent collapse to that directory's ... pattern", async () => {
  const commands = await resolveScopedChecks({
    files: ["pkg/foo/a.go", "pkg/bar/b.go"],
    repo,
    env: {},
  });
  assert.deepEqual(commands, ["go test ./pkg/..."]);
});

test("Go packages in different trees are listed instead of testing the whole repo", async () => {
  const commands = await resolveScopedChecks({
    files: ["cmd/tool/main.go", "pkg/foo/a.go"],
    repo,
    env: {},
  });
  assert.deepEqual(commands, ["go test ./cmd/tool ./pkg/foo"]);
});

test("a nested Go module is tested with go test -C, not from the repo root", async () => {
  const commands = await resolveScopedChecks({
    files: ["services/api/internal/db/db.go"],
    repo: { ...repo, goModule: { "services/api/internal/db/db.go": "services/api" } },
    env: {},
  });
  assert.deepEqual(commands, ["go test -C services/api ./internal/db"]);
});

test("golangci-lint is added only when a config or binary is present", async () => {
  assert.deepEqual(await checks(["pkg/foo/a.go"], { golangci: true }), [
    "go test ./pkg/foo",
    "golangci-lint run ./pkg/foo",
  ]);
  assert.deepEqual(await checks(["pkg/foo/a.go", "pkg/bar/b.go"]), ["go test ./pkg/..."]);
});

test("TypeScript files use tsc --noEmit on the nearest tsconfig", async () => {
  const commands = await checks(["packages/app/src/a.ts", "packages/app/src/b.tsx"], {
    tsconfigs: {
      "packages/app/src/a.ts": ["packages/app/tsconfig.json"],
      "packages/app/src/b.tsx": ["packages/app/tsconfig.json"],
    },
  });
  assert.deepEqual(commands, ["tsc --noEmit -p packages/app/tsconfig.json"]);
});

test("Jev chooses one tsconfig when the nearest directory has several", async () => {
  const calls = [];
  const commands = await resolveScopedChecks({
    files: ["src/main.ts", "pkg/foo/a.go"],
    repo: {
      ...repo,
      tsconfigs: { "src/main.ts": ["src/tsconfig.app.json", "src/tsconfig.node.json"] },
    },
    env: { TYPESAFE_API_KEY: "test-key", LORE_CONFIG: "/no/such/lore.json" },
    ask: async (request) => {
      calls.push(request);
      return { answers: { pick_0: { type: "choice", choice: "c1" } } };
    },
  });
  assert.equal(calls.length, 1);
  validateRequest(calls[0]);
  assert.equal(calls[0].questions.pick_0.type, "choice");
  assert.deepEqual(Object.keys(calls[0].questions.pick_0.criteria).sort(), ["c0", "c1"]);
  assert.deepEqual(commands, ["go test ./pkg/foo", "tsc --noEmit -p src/tsconfig.node.json"]);
});

test("a plain tsconfig.json is used without asking Jev", async () => {
  let asked = false;
  const commands = await resolveScopedChecks({
    files: ["src/a.ts"],
    repo: {
      ...repo,
      tsconfigs: { "src/a.ts": ["src/tsconfig.build.json", "src/tsconfig.json"] },
    },
    env: { TYPESAFE_API_KEY: "test-key", LORE_CONFIG: "/no/such/lore.json" },
    ask: async () => {
      asked = true;
      return {};
    },
  });
  assert.equal(asked, false);
  assert.deepEqual(commands, ["tsc --noEmit -p src/tsconfig.json"]);
});

test("a failed or unusable Jev answer keeps every candidate tsconfig", async () => {
  const files = ["src/main.ts"];
  const ambiguous = {
    ...repo,
    tsconfigs: { "src/main.ts": ["src/tsconfig.app.json", "src/tsconfig.node.json"] },
  };
  const env = { TYPESAFE_API_KEY: "test-key", LORE_CONFIG: "/no/such/lore.json" };
  const expected = [
    "tsc --noEmit -p src/tsconfig.app.json",
    "tsc --noEmit -p src/tsconfig.node.json",
  ];
  assert.deepEqual(
    await resolveScopedChecks({
      files,
      repo: ambiguous,
      env,
      ask: async () => {
        throw new Error("down");
      },
    }),
    expected,
  );
  assert.deepEqual(
    await resolveScopedChecks({
      files,
      repo: ambiguous,
      env,
      ask: async () => ({ answers: { pick_0: { type: "choice", choice: "neither" } } }),
    }),
    expected,
  );
});

test("a Go file under testdata belongs to the parent package", async () => {
  assert.deepEqual(await checks(["pkg/foo/testdata/fix.go"]), ["go test ./pkg/foo"]);
});

test("package paths with spaces are shell-quoted", async () => {
  assert.deepEqual(await checks(["my pkg/a.go"]), ["go test './my pkg'"]);
});

test("golangci-lint on PATH is used when the repo has no config", async () => {
  const root = mkdtempSync(join(tmpdir(), "done-gate-scope-"));
  const bin = mkdtempSync(join(tmpdir(), "done-gate-bin-"));
  try {
    writeFileSync(join(bin, "golangci-lint"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(bin, "golangci-lint"), 0o755);
    mkdirSync(join(root, "pkg/foo"), { recursive: true });
    writeFileSync(join(root, "go.mod"), "module example.com/app\n");
    const commands = await resolveScopedChecks({
      root,
      files: ["pkg/foo/a.go"],
      env: { PATH: bin, LORE_CONFIG: "/no/such/lore.json", HOME: "/no/such/home" },
    });
    assert.deepEqual(commands, ["go test ./pkg/foo", "golangci-lint run ./pkg/foo"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test("a discovered .pi/verify directory replaces language commands", async () => {
  const root = mkdtempSync(join(tmpdir(), "done-gate-scope-"));
  try {
    mkdirSync(join(root, ".pi/verify"), { recursive: true });
    mkdirSync(join(root, "pkg/foo"), { recursive: true });
    writeFileSync(join(root, "go.mod"), "module example.com/app\n");
    writeFileSync(join(root, ".golangci.yml"), "version: 2\n");
    const commands = await resolveScopedChecks({
      root,
      files: ["pkg/foo/a.go"],
      env: { PATH: "", LORE_CONFIG: "/no/such/lore.json", HOME: "/no/such/home" },
    });
    assert.deepEqual(commands, [".pi/verify"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("discovery reads each changed file's module, tsconfig and tool configs", async () => {
  const root = mkdtempSync(join(tmpdir(), "done-gate-scope-"));
  try {
    mkdirSync(join(root, "pkg/foo"), { recursive: true });
    mkdirSync(join(root, "services/api/internal/db"), { recursive: true });
    mkdirSync(join(root, "packages/app/src"), { recursive: true });
    mkdirSync(join(root, "plugin"), { recursive: true });
    writeFileSync(join(root, "go.mod"), "module example.com/root\n");
    writeFileSync(join(root, "services/api/go.mod"), "module example.com/api\n");
    writeFileSync(join(root, ".golangci.yml"), "version: 2\n");
    writeFileSync(join(root, "packages/app/tsconfig.json"), "{}\n");
    writeFileSync(join(root, "stylua.toml"), 'indent_type = "Spaces"\n');
    writeFileSync(join(root, "plugin/selene.toml"), 'std = "lua51"\n');
    const commands = await resolveScopedChecks({
      root,
      files: [
        "pkg/foo/a.go",
        "services/api/internal/db/db.go",
        "packages/app/src/main.ts",
        "plugin/init.lua",
        "loose.lua",
      ],
      env: { PATH: "", LORE_CONFIG: "/no/such/lore.json", HOME: "/no/such/home" },
    });
    assert.deepEqual(commands, [
      "go test ./pkg/foo",
      "go test -C services/api ./internal/db",
      "golangci-lint run ./pkg/foo ./services/api/internal/db",
      "tsc --noEmit -p packages/app/tsconfig.json",
      "stylua --check loose.lua plugin/init.lua",
      "selene plugin/init.lua",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("scoped commands are verification commands the gate accepts", async () => {
  const commands = await checks(["services/api/internal/db/db.go", "src/a.ts", "plugin/init.lua"], {
    golangci: true,
    goModule: { "services/api/internal/db/db.go": "services/api" },
    tsconfigs: { "src/a.ts": ["tsconfig.json"] },
    stylua: ["plugin/init.lua"],
    selene: ["plugin/init.lua"],
  });
  assert.deepEqual(commands, [
    "go test -C services/api ./internal/db",
    "golangci-lint run ./services/api/internal/db",
    "tsc --noEmit -p tsconfig.json",
    "stylua --check plugin/init.lua",
    "selene plugin/init.lua",
  ]);
  for (const command of commands) assert.equal(isVerifyCommand(command), true, command);
  assert.equal(isVerifyCommand("go test './my pkg'"), true);
});

test("a .pi/verify path replaces the per-language commands", async () => {
  const commands = await checks(["pkg/foo/a.go", "src/a.ts", "plugin/init.lua"], {
    verify: true,
    golangci: true,
    tsconfigs: { "src/a.ts": ["tsconfig.json"] },
    stylua: ["plugin/init.lua"],
    selene: ["plugin/init.lua"],
  });
  assert.deepEqual(commands, [".pi/verify"]);
});

test("Lua checks name the changed files and only the tools whose configs exist", async () => {
  const files = ["plugin/util.lua", "plugin/init.lua", "other.lua"];
  assert.deepEqual(
    await checks(files, {
      stylua: ["plugin/init.lua", "plugin/util.lua"],
      selene: ["plugin/init.lua"],
    }),
    ["stylua --check plugin/init.lua plugin/util.lua", "selene plugin/init.lua"],
  );
  assert.deepEqual(await checks(files), []);
});

test("several tsconfigs and no plain tsconfig.json all stay when Jev is unavailable", async () => {
  let asked = false;
  const commands = await resolveScopedChecks({
    files: ["src/main.ts"],
    repo: {
      ...repo,
      tsconfigs: { "src/main.ts": ["src/tsconfig.app.json", "src/tsconfig.node.json"] },
    },
    env: { LORE_CONFIG: "/no/such/lore.json", HOME: "/no/such/home" },
    ask: async () => {
      asked = true;
      return {};
    },
  });
  assert.equal(asked, false, "no TypeSafe key means no judgment");
  assert.deepEqual(commands, [
    "tsc --noEmit -p src/tsconfig.app.json",
    "tsc --noEmit -p src/tsconfig.node.json",
  ]);
});
