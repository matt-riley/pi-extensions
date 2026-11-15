// deps.mjs — the dependency sentinel's detection: pure text in, hits out.
//
// A new dependency is code from a stranger that runs with your permissions, so
// adding one is a human decision. This module only spots the change; index.ts
// asks. No network, no registry lookups, no filesystem: every rule is a test.
//
// Shell commands are read with the shared parser. A plain `npm install` or
// `npm ci` names no package, only restores the lockfile, and is not a hit.

import { findHead, splitSegments, tokenize } from "../../shared/shell-parse.mjs";

// Flags that take their value as the next word, per manager. A flag written as
// --flag=value needs no entry. Wrong entries only cost a stray prompt or a
// missed package name, so these stay short and specific.
const VALUE_FLAGS = {
  npm: ["--prefix", "-w", "--workspace", "--registry", "--tag", "--cache", "--omit", "--include"],
  pnpm: ["--filter", "-F", "--dir", "-C", "--registry", "--workspace-root"],
  yarn: ["--cwd", "--registry", "--modules-folder"],
  bun: ["--cwd", "--registry", "--config", "-c"],
  go: ["-C", "-tags", "-ldflags", "-gcflags", "-mod", "-modfile"],
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
};

const SHELLS = new Set(["sh", "bash", "zsh"]);
const ESCALATORS = new Set(["sudo", "doas"]);
const MAX_DEPTH = 3;

// Go arguments that mean "this directory", not a downloaded package.
const isLocalGoTarget = (word) => /^(\.|\.\.|\/|~)(\/|$)/.test(word) || word === ".";

// Split a segment's arguments into the verb and the positional words after it.
function verbAndWords(manager, args) {
  const valueFlags = VALUE_FLAGS[manager];
  const words = [];
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (word === "--") {
      words.push(...args.slice(i + 1));
      break;
    }
    if (word.startsWith("-") && word !== "-") {
      if (!word.includes("=") && valueFlags.includes(word)) i++;
      continue;
    }
    words.push(word);
  }
  return { verb: words[0], words: words.slice(1) };
}

function installHit(head, args) {
  if (!Object.hasOwn(ADD_VERBS, head ?? "")) return null;
  const { verb, words } = verbAndWords(head, args);
  if (!ADD_VERBS[head].includes(verb)) return null;
  // `go install .` builds this module; `go get` always edits go.mod.
  const packages =
    head === "go" && verb === "install" ? words.filter((w) => !isLocalGoTarget(w)) : words;
  if (!packages.length) return null;
  return { manager: head, verb: head === "npm" && verb !== "add" ? "install" : verb, packages };
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
// File edits: package.json dependency sections and go.mod require lines.
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

/**
 * Dependencies a write or edit call would add or re-version in a package.json
 * or go.mod: [{ file, section, name, from, to }]. `before` is the file's
 * current text (undefined when it does not exist yet).
 */
export function fileDependencyChanges({ path, input, before } = {}) {
  const file = String(path ?? "");
  const parts = file.split(/[\\/]/);
  const kind = parts.at(-1);
  if ((kind !== "package.json" && kind !== "go.mod") || parts.includes("node_modules")) return [];
  const after = textAfter(before, input);
  if (after === null) return [];
  const read = kind === "go.mod" ? goRequirements : packageRequirements;
  const next = read(after);
  // Invalid JSON after the edit cannot be judged; a broken file before counts as empty.
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
