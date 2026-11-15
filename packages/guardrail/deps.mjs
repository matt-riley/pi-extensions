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
