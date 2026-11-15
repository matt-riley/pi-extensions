// deps.mjs — the dependency sentinel's detection: pure text in, hits out.
//
// A new dependency is code from a stranger that runs with your permissions, so
// adding one is a human decision. This module only spots the change; index.ts
// asks. No network, no registry lookups, no filesystem: every rule is a test.
//
// Shell commands are read with the shared parser. A plain `npm install` or
// `npm ci` names no package, only restores the lockfile, and is not a hit.

import { findHead, splitSegments, tokenize } from "../../shared/shell-parse.mjs";
import { cargoRequirements, pyprojectRequirements } from "./deps-toml.mjs";

// Flags that take their value as the next word, per manager. A flag written as
// --flag=value needs no entry. Wrong entries only cost a stray prompt or a
// missed package name, so these stay short and specific.
const flags = (...lines) => lines.join(" ").split(" ");
const PIP_FLAGS = flags(
  "-r --requirement -c --constraint -e --editable -i --index-url",
  "--extra-index-url -f --find-links -t --target --prefix --root",
  "--python --python-version --platform --implementation --abi --src",
  "--upgrade-strategy --no-binary --only-binary --progress-bar --proxy",
  "--retries --timeout --cert --client-cert --cache-dir --log -C",
  "--config-settings --exists-action --trusted-host --report",
);
const UV_FLAGS = flags(
  "--group --optional --extra --rev --tag --branch --index -p",
  "--default-index --index-url --extra-index-url -f --find-links -r",
  "--index-strategy --resolution --prerelease --link-mode --package",
  "--project --directory --script --bounds --marker -m -c",
  "--exclude-newer --requirements --constraints --config-file --python",
  "--keyring-provider --refresh-package --reinstall-package -P --upgrade-package",
);
const VALUE_FLAGS = {
  npm: flags("--prefix -w --workspace --registry --tag --cache --omit --include"),
  pnpm: flags("--filter -F --dir -C --registry --workspace-root"),
  yarn: flags("--cwd --registry --modules-folder"),
  bun: flags("--cwd --registry --config -c"),
  go: flags("-C -tags -ldflags -gcflags -mod -modfile"),
  cargo: flags(
    "--features -F --rename --registry --manifest-path --package -p",
    "--target --branch --tag --rev --path --git --version --vers",
    "--root --index --jobs -j --target-dir --bin --example --profile",
    "--message-format --config -Z --color",
  ),
  pip: PIP_FLAGS,
  "uv pip": [...PIP_FLAGS, ...UV_FLAGS],
  uv: UV_FLAGS,
  poetry: flags("--group -G --extras -E --python --platform --source -C -P --directory --project"),
};

// The verbs that add packages. `npm i` is spelled many ways; the long tail of
// npm's abbreviations is covered, since a typo-tolerant CLI is part of the risk.
const NPM_VERBS = ["i", "in", "ins", "inst", "insta", "instal", "install", "add"];
const ADD_VERBS = {
  npm: NPM_VERBS,
  pnpm: ["add", "install", "i"],
  yarn: ["add", "install"],
  bun: ["add", "install", "i"],
  go: ["get", "install"],
  cargo: ["add", "install"],
  pip: ["install"],
  "uv pip": ["install"],
  uv: ["add"],
  poetry: ["add"],
};

// Managers where a path argument means "this directory or file", not a download.
const LOCAL_PATHS = new Set(["pip", "uv pip", "uv", "poetry"]);

const SHELLS = new Set(["sh", "bash", "zsh"]);
const ESCALATORS = new Set(["sudo", "doas"]);
const MAX_DEPTH = 3;

// Arguments that mean "this directory", not a downloaded package.
const isLocalPath = (word) => /^(\.|\.\.|\/|~)(\/|$)/.test(word) || word === ".";

// Split a segment's arguments into the verb, the positional words after it and
// the values of the flags that take one (by flag name, so --git=x and --git x agree).
function readArgs(manager, args) {
  const valueFlags = VALUE_FLAGS[manager];
  const words = [];
  const values = {};
  const take = (flag, value) => (values[flag] ??= []).push(value);
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (word === "--") {
      words.push(...args.slice(i + 1));
      break;
    }
    // `cargo +nightly add` names a toolchain, not a package.
    if (word.startsWith("+") && words.length === 0) continue;
    if (word.startsWith("-") && word !== "-") {
      const eq = word.indexOf("=");
      if (eq > 0) take(word.slice(0, eq), word.slice(eq + 1));
      else if (valueFlags.includes(word)) take(word, args[++i] ?? "");
      continue;
    }
    words.push(word);
  }
  return { verb: words[0], words: words.slice(1), values };
}

// `pip3.12`, `python -m pip` and `uv pip` are all pip; `uv add` is uv's own.
function managerOf(head, args) {
  if (/^pip\d*(\.\d+)?$/.test(head ?? "")) return { manager: "pip", args };
  if (/^python[\d.]*$/.test(head ?? "") && args[0] === "-m" && args[1] === "pip") {
    return { manager: "pip", args: args.slice(2) };
  }
  if (head === "uv") {
    const first = args.findIndex((word) => !word.startsWith("-"));
    if (args[first] === "pip") return { manager: "uv pip", args: args.slice(first + 1) };
  }
  return { manager: head, args };
}

function installHit(head, allArgs) {
  const { manager, args } = managerOf(head, allArgs);
  if (!Object.hasOwn(ADD_VERBS, manager ?? "")) return null;
  const { verb, words, values } = readArgs(manager, args);
  if (!ADD_VERBS[manager].includes(verb)) return null;
  let packages = words;
  if (manager === "cargo") {
    // --path is a crate on this disk; --git with no crate name is the url itself.
    if (values["--path"]) return null;
    if (!packages.length && values["--git"]) packages = values["--git"];
  }
  // `pip install -e git+https://…` is a download; `-e .` is this project.
  if (manager === "pip" || manager === "uv pip") {
    packages = [...packages, ...(values["-e"] ?? []), ...(values["--editable"] ?? [])];
  }
  // `go install .` builds this module; `go get` always edits go.mod.
  if (LOCAL_PATHS.has(manager) || (manager === "go" && verb === "install")) {
    packages = packages.filter((word) => !isLocalPath(word));
  }
  if (!packages.length) return null;
  return { manager, verb: manager === "npm" && verb !== "add" ? "install" : verb, packages };
}

function segmentHits(segment, depth) {
  const { head, args } = findHead(tokenize(segment));
  if (ESCALATORS.has(head) && depth < MAX_DEPTH) return commandHits(args.join(" "), depth + 1);
  if (SHELLS.has(head) && depth < MAX_DEPTH) {
    const flag = args.findIndex((word) => /^-[a-z]*c$/.test(word));
    if (flag >= 0 && args[flag + 1] !== undefined) return commandHits(args[flag + 1], depth + 1);
    return [];
  }
  const hit = installHit(head, args);
  return hit ? [hit] : [];
}

function commandHits(command, depth) {
  return splitSegments(command).flatMap((segment) => segmentHits(segment, depth));
}

/**
 * Package installs in a shell command: [{ manager, verb, packages }], one per
 * segment that adds something. Empty when it only restores the lockfile.
 */
export function bashDependencyInstalls(command) {
  return typeof command === "string" ? commandHits(command, 0) : [];
}

// ---------------------------------------------------------------------------
// File edits: package.json, go.mod, Cargo.toml and pyproject.toml dependencies.
//
// The edit tool carries only snippets, so the change is found by applying the
// call to the file's current text in memory and comparing what each version
// requires. Only additions and changed versions count: removing a dependency
// installs nothing, and scripts, name, version and the rest are not read at all.

const PACKAGE_SECTIONS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];

function packageRequirements(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const found = new Map();
  for (const section of PACKAGE_SECTIONS) {
    const entries = parsed?.[section];
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) continue;
    for (const [name, range] of Object.entries(entries)) {
      found.set(`${section}\0${name}`, { section, name, version: String(range) });
    }
  }
  return found;
}

function goRequirements(text) {
  const found = new Map();
  let inBlock = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, "").trim();
    if (!line) continue;
    let body = null;
    if (inBlock) {
      if (line === ")") inBlock = false;
      else body = line;
    } else if (/^require\s*\(/.test(line)) inBlock = true;
    else if (/^require\s/.test(line)) body = line.replace(/^require\s+/, "");
    const [name, version] = (body ?? "").split(/\s+/);
    if (name && version) found.set(name, { section: "require", name, version });
  }
  return found;
}

// The text a write or edit call would leave behind, or null when the call is
// not one this module understands or its edits do not apply to the file.
function textAfter(before, input) {
  if (typeof input?.content === "string") return input.content;
  const edits = Array.isArray(input?.edits)
    ? input.edits
    : typeof input?.oldText === "string"
      ? [{ oldText: input.oldText, newText: input.newText }]
      : [];
  if (!edits.length || typeof before !== "string") return null;
  let text = before;
  for (const { oldText, newText } of edits) {
    if (typeof oldText !== "string" || typeof newText !== "string" || !text.includes(oldText)) {
      return null;
    }
    text = text.replace(oldText, () => newText);
  }
  return text;
}

// Files the sentinel reads, and how each one lists what it requires.
const READERS = {
  "package.json": packageRequirements,
  "go.mod": goRequirements,
  "Cargo.toml": cargoRequirements,
  "pyproject.toml": pyprojectRequirements,
};
const DEPENDENCY_FILE = /(^|[\\/])(package\.json|go\.mod|Cargo\.toml|pyproject\.toml)$/;

/**
 * Dependencies a write or edit call would add or re-version in a package.json,
 * go.mod, Cargo.toml or pyproject.toml: [{ file, section, name, from, to }]. `before` is the file's
 * current text (undefined when it does not exist yet).
 */
export function fileDependencyChanges({ path, input, before } = {}) {
  const file = String(path ?? "");
  const parts = file.split(/[\\/]/);
  const kind = parts.at(-1);
  if (!Object.hasOwn(READERS, kind) || parts.includes("node_modules")) return [];
  const after = textAfter(before, input);
  if (after === null) return [];
  const read = READERS[kind];
  const next = read(after);
  // A file that cannot be read after the edit cannot be judged; a broken file before counts as empty.
  if (!next) return [];
  const previous = (typeof before === "string" ? read(before) : null) ?? new Map();
  const changes = [];
  for (const [key, entry] of next) {
    const old = previous.get(key);
    if (old?.version === entry.version) continue;
    changes.push({
      file: kind,
      section: entry.section,
      name: entry.name,
      from: old?.version ?? null,
      to: entry.version,
    });
  }
  return changes;
}

// ---------------------------------------------------------------------------
// The confirmation the guardrail shows.

const MAX_NAMES = 5;

function listNames(names) {
  const shown = names.slice(0, MAX_NAMES).join(", ");
  return names.length > MAX_NAMES ? `${shown} and ${names.length - MAX_NAMES} more` : shown;
}

/** The file an edit or write call would change, when it is a dependency file; else null. */
export function dependencyEditPath(toolName, input) {
  const tool = String(toolName ?? "").toLowerCase();
  const path = input?.path;
  if ((tool !== "edit" && tool !== "write") || typeof path !== "string") return null;
  return DEPENDENCY_FILE.test(path) ? path : null;
}

/**
 * Whether a tool call changes dependencies: null, or { reason, scopes } for the
 * guardrail to ask about. `before` is the current text of the file an edit or
 * write targets (see dependencyEditPath).
 */
export function dependencyConfirmation({ toolName, input, before } = {}) {
  const tool = String(toolName ?? "").toLowerCase();
  if (tool === "bash") {
    const hits = bashDependencyInstalls(input?.command);
    if (!hits.length) return null;
    return {
      reason: hits
        .map(
          (hit) => `${hit.manager} ${hit.verb} would add dependencies: ${listNames(hit.packages)}`,
        )
        .join("; "),
      scopes: hits.flatMap((hit) =>
        hit.packages.map((name) => `dependency:${hit.manager}:${name}`),
      ),
    };
  }
  const path = dependencyEditPath(tool, input);
  if (!path) return null;
  const changes = fileDependencyChanges({ path, input, before });
  if (!changes.length) return null;
  const label = (change) =>
    `${change.name} ${change.from ? `${change.from} → ` : ""}${change.to} (${change.section})`;
  return {
    reason: `${tool} would change dependencies in ${changes[0].file}: ${listNames(changes.map(label))}`,
    scopes: changes.map((c) => `dependency:${c.file}:${c.section}:${c.name}`),
  };
}
