// scoped.mjs — which checks apply to the files a run changed.
//
// The mapping is deterministic and does not need TypeSafe. Jev is asked only
// when a changed TypeScript file's nearest directory has several tsconfigs and
// none of them is tsconfig.json. No key, a failed request, or an unusable
// answer keeps every candidate. A `.pi/verify` path, when the snapshot says it
// is present, replaces the per-language commands.

import { accessSync, constants } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, posix } from "node:path";

import { askSystemOne } from "../../shared/systemone.mjs";
import { resolveApiKey } from "../../shared/systemone-config.mjs";

const SCOPE_TIMEOUT_MS = 4000;

function normalized(file) {
  return String(file).replaceAll("\\", "/").replace(/^\.\//, "");
}

function shQuote(arg) {
  const text = String(arg);
  if (/^[A-Za-z0-9_./@+=,~-]+$/.test(text)) return text;
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

function packageDir(file) {
  const dir = posix.dirname(normalized(file));
  if (dir === ".") return "";
  // testdata is not a package. The Go tool ignores it, so the check is the parent.
  const parts = dir.split("/");
  const testdata = parts.indexOf("testdata");
  return (testdata === -1 ? parts : parts.slice(0, testdata)).join("/");
}

function moduleDir(file, repo) {
  const recorded = repo.goModule?.[normalized(file)];
  if (typeof recorded !== "string") return "";
  const module = recorded.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (!module || module === ".") return "";
  const dir = packageDir(file);
  return dir === module || dir.startsWith(`${module}/`) ? module : "";
}

function relativePackage(file, module) {
  const dir = packageDir(file);
  if (!module || dir === module) return module ? "" : dir;
  return dir.startsWith(`${module}/`) ? dir.slice(module.length + 1) : dir;
}

function formatPkg(dir) {
  return dir ? `./${dir}` : ".";
}

// Several packages under one directory become `./that/...`. Packages that only
// meet at the repo root stay listed: `./...` would be the whole module.
function goPatterns(dirs) {
  const unique = [...dirs].sort();
  if (unique.length === 1) return [formatPkg(unique[0])];
  if (unique.includes("")) return unique.map(formatPkg);
  const split = unique.map((dir) => dir.split("/"));
  let shared = 0;
  while (split.every((parts) => parts.length > shared && parts[shared] === split[0][shared])) {
    shared += 1;
  }
  if (shared === 0) return unique.map(formatPkg);
  return [`./${split[0].slice(0, shared).join("/")}/...`];
}

function repoPattern(module, pattern) {
  if (!module) return pattern;
  if (pattern === ".") return `./${module}`;
  return pattern.startsWith("./") ? `./${module}/${pattern.slice(2)}` : pattern;
}

function goCommands(files, repo) {
  const byModule = new Map();
  for (const file of files ?? []) {
    if (typeof file !== "string" || !file.endsWith(".go")) continue;
    const module = moduleDir(file, repo);
    const packages = byModule.get(module) ?? new Set();
    packages.add(relativePackage(file, module));
    byModule.set(module, packages);
  }
  const commands = [];
  const lint = [];
  for (const module of [...byModule.keys()].sort()) {
    const patterns = goPatterns(byModule.get(module));
    const args = patterns.map(shQuote).join(" ");
    commands.push(module ? `go test -C ${shQuote(module)} ${args}` : `go test ${args}`);
    for (const pattern of patterns) lint.push(shQuote(repoPattern(module, pattern)));
  }
  if (repo.golangci === true && lint.length) commands.push(`golangci-lint run ${lint.join(" ")}`);
  return commands;
}

const TS_FILE = /\.(?:tsx?|mts|cts)$/i;

function tscCommand(configPath) {
  return `tsc --noEmit -p ${shQuote(configPath)}`;
}

// A plain tsconfig.json is the project. Several other names in the same
// directory are a real choice (app vs node), which is the only judgment here.
function tsPlan(files, repo) {
  const fixed = new Set();
  const groups = new Map();
  for (const file of files ?? []) {
    if (typeof file !== "string" || !TS_FILE.test(file)) continue;
    const candidates = repo.tsconfigs?.[normalized(file)];
    if (!Array.isArray(candidates) || candidates.length === 0) continue;
    const paths = [...new Set(candidates.map((path) => normalized(path)))].sort();
    const plain = paths.find((path) => posix.basename(path) === "tsconfig.json");
    if (plain || paths.length < 2) {
      fixed.add(plain ?? paths[0]);
      continue;
    }
    const key = paths.join("\0");
    const group = groups.get(key) ?? { files: [], paths };
    group.files.push(normalized(file));
    groups.set(key, group);
  }
  const ambiguous = [...groups.values()].map((group) => ({
    files: group.files,
    options: group.paths.map((path, index) => ({ id: `c${index}`, command: tscCommand(path) })),
  }));
  return { fixed: [...fixed].sort(), ambiguous };
}

function scopeQuestions(groups) {
  return Object.fromEntries(
    groups.map((group, index) => [
      `pick_${index}`,
      {
        type: "choice",
        instructions:
          "Read `groups`. Each entry lists changed files and the tsc commands that might typecheck them. " +
          `For group ${index}, choose the command id whose tsconfig includes those files. ` +
          "A config for a different runtime does not apply.",
        criteria: Object.fromEntries(group.options.map((option) => [option.id, option.command])),
      },
    ]),
  );
}

function commandsFor(group, answer) {
  const id = answer?.type === "choice" && typeof answer.choice === "string" ? answer.choice : null;
  const match = group.options.find((option) => option.id === id);
  return (match ? [match] : group.options).map((option) => option.command);
}

async function narrowTs(groups, ask, env) {
  const result = await ask({
    state: {
      groups: groups.map((group) => ({
        files: group.files,
        options: group.options.map((option) => ({ id: option.id, command: option.command })),
      })),
    },
    questions: scopeQuestions(groups),
    env,
    signal: AbortSignal.timeout(SCOPE_TIMEOUT_MS),
    feature: "done-gate",
  });
  return groups.flatMap((group, index) => commandsFor(group, result?.answers?.[`pick_${index}`]));
}

const LUA_FILE = /\.lua$/i;

function luaFiles(files, selected) {
  const wanted = new Set(
    (files ?? [])
      .filter((file) => typeof file === "string" && LUA_FILE.test(file))
      .map((file) => normalized(file)),
  );
  return [
    ...new Set((selected ?? []).map((file) => normalized(file)).filter((file) => wanted.has(file))),
  ].sort();
}

function luaCommands(files, repo) {
  const commands = [];
  const stylua = luaFiles(files, repo.stylua);
  const selene = luaFiles(files, repo.selene);
  if (stylua.length) commands.push(`stylua --check ${stylua.map(shQuote).join(" ")}`);
  if (selene.length) commands.push(`selene ${selene.map(shQuote).join(" ")}`);
  return commands;
}

function tsCommands(plan, picked) {
  const chosen =
    picked ?? plan.ambiguous.flatMap((group) => group.options.map((option) => option.command));
  return [...plan.fixed.map(tscCommand), ...chosen].sort();
}

const GOLANGCI_CONFIGS = [".golangci.yml", ".golangci.yaml", ".golangci.toml", ".golangci.json"];
const STYLUA_CONFIGS = ["stylua.toml", ".stylua.toml"];
const TSCONFIG = /^tsconfig(?:\..+)?\.json$/;

function commandOnPath(name, env) {
  const path = typeof env?.PATH === "string" ? env.PATH : "";
  for (const dir of path.split(":")) {
    if (!dir) continue;
    try {
      accessSync(join(dir, name), constants.X_OK);
      return true;
    } catch {
      // The next PATH entry may have it.
    }
  }
  return false;
}

function ancestorDirs(file) {
  const dirs = [];
  let dir = posix.dirname(normalized(file));
  if (dir === ".") dir = "";
  while (dir) {
    dirs.push(dir);
    const parent = posix.dirname(dir);
    dir = parent === "." ? "" : parent;
  }
  dirs.push("");
  return dirs;
}

async function directoryNames(root, dir, cache) {
  if (cache.has(dir)) return cache.get(dir);
  let names = [];
  try {
    names = await readdir(join(root, dir));
  } catch {
    names = [];
  }
  const set = new Set(names);
  cache.set(dir, set);
  return set;
}

async function discoverRepo(root, files, env) {
  const cache = new Map();
  const repo = {
    verify: false,
    golangci: commandOnPath("golangci-lint", env),
    goModule: {},
    tsconfigs: {},
    stylua: [],
    selene: [],
  };
  try {
    await stat(join(root, ".pi", "verify"));
    repo.verify = true;
  } catch {
    repo.verify = false;
  }
  for (const file of files ?? []) {
    if (typeof file !== "string") continue;
    const rel = normalized(file);
    let goMod;
    let tsconfigs = null;
    let stylua = false;
    let selene = false;
    for (const dir of ancestorDirs(rel)) {
      const names = await directoryNames(root, dir, cache);
      if (goMod === undefined && names.has("go.mod")) goMod = dir;
      if (!tsconfigs) {
        const configs = [...names].filter((name) => TSCONFIG.test(name)).sort();
        if (configs.length) tsconfigs = configs.map((name) => (dir ? `${dir}/${name}` : name));
      }
      if (!stylua && STYLUA_CONFIGS.some((name) => names.has(name))) stylua = true;
      if (!selene && names.has("selene.toml")) selene = true;
      if (!repo.golangci && GOLANGCI_CONFIGS.some((name) => names.has(name))) repo.golangci = true;
    }
    if (rel.endsWith(".go") && goMod !== undefined) repo.goModule[rel] = goMod;
    if (TS_FILE.test(rel) && tsconfigs) repo.tsconfigs[rel] = tsconfigs;
    if (LUA_FILE.test(rel) && stylua) repo.stylua.push(rel);
    if (LUA_FILE.test(rel) && selene) repo.selene.push(rel);
  }
  return repo;
}

/**
 * Commands that verify `files`.
 *
 * Pass `repo` to skip the filesystem. Otherwise `root` is read: configs and
 * go.mod files next to the changed paths, and `golangci-lint` on `env.PATH`.
 */
export async function resolveScopedChecks({
  files,
  repo,
  root,
  ask = askSystemOne,
  env = process.env,
} = {}) {
  let snapshot = repo;
  if (!snapshot) {
    try {
      snapshot = root ? await discoverRepo(root, files, env) : {};
    } catch {
      snapshot = {};
    }
  }
  if (snapshot.verify === true) return [".pi/verify"];
  const plan = tsPlan(files, snapshot);
  let picked = null;
  if (plan.ambiguous.length > 0 && resolveApiKey(env) && typeof ask === "function") {
    try {
      picked = await narrowTs(plan.ambiguous, ask, env);
    } catch {
      picked = null;
    }
  }
  return [
    ...goCommands(files, snapshot),
    ...tsCommands(plan, picked),
    ...luaCommands(files, snapshot),
  ];
}
