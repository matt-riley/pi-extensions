// deps-toml.mjs — what a Cargo.toml or pyproject.toml requires, read with the
// small TOML reader in toml.mjs.
//
// Each reader returns a Map of "section\0name" → { section, name, version }, or
// null when the file cannot be read. `version` is the requirement as written
// (or a short label for a git, path or url source); it only has to change when
// what would be installed changes. Features, extras lists and markers on a
// table entry do not count, but a marker or extra inside a requirement string
// does, because the string is compared whole.

import { parseToml } from "./toml.mjs";

const isTable = (value) => value && typeof value === "object" && !Array.isArray(value);

// The parts of a dependency table that decide where its code comes from.
const SOURCE_PARTS = [
  ["version", ""],
  ["git", "git "],
  ["branch", "branch "],
  ["tag", "tag "],
  ["rev", "rev "],
  ["path", "path "],
  ["url", "url "],
  ["registry", "registry "],
  ["source", "source "],
  ["package", "package "],
];

function sourceLabel(entry) {
  if (typeof entry === "string") return entry;
  if (Array.isArray(entry)) return entry.map(sourceLabel).join(" | ");
  if (!isTable(entry)) return String(entry);
  const parts = SOURCE_PARTS.filter(([key]) => typeof entry[key] === "string").map(
    ([key, prefix]) => `${prefix}${entry[key]}`,
  );
  if (entry.workspace === true) parts.push("workspace");
  return parts.join(" ") || "*";
}

function add(found, section, name, version) {
  const key = `${section}\0${name}`;
  const old = found.get(key);
  found.set(key, { section, name, version: old ? `${old.version} | ${version}` : version });
}

function addTable(found, section, entries, skip = []) {
  if (!isTable(entries)) return;
  for (const [name, entry] of Object.entries(entries)) {
    if (!skip.includes(name)) add(found, section, name, sourceLabel(entry));
  }
}

const CARGO_TABLES = [
  "dependencies",
  "dev-dependencies",
  "build-dependencies",
  "dev_dependencies",
  "build_dependencies",
];

export function cargoRequirements(text) {
  const doc = parseToml(text);
  if (!doc) return null;
  const found = new Map();
  for (const name of CARGO_TABLES) addTable(found, name, doc[name]);
  if (isTable(doc.target)) {
    for (const [cfg, target] of Object.entries(doc.target)) {
      for (const name of CARGO_TABLES) addTable(found, `target.${cfg}.${name}`, target?.[name]);
    }
  }
  addTable(found, "workspace.dependencies", doc.workspace?.dependencies);
  return found;
}

// A PEP 508 requirement: the name, then everything else (extras, range,
// marker, or an @ url) as the version.
function addRequirement(found, section, line) {
  if (typeof line !== "string") return;
  const text = line.trim();
  const name = /^[A-Za-z0-9][A-Za-z0-9._-]*/.exec(text)?.[0] ?? text;
  add(found, section, name, text.slice(name.length).trim() || "*");
}

function addRequirements(found, section, lines) {
  if (Array.isArray(lines)) for (const line of lines) addRequirement(found, section, line);
}

export function pyprojectRequirements(text) {
  const doc = parseToml(text);
  if (!doc) return null;
  const found = new Map();
  addRequirements(found, "project.dependencies", doc.project?.dependencies);
  if (isTable(doc.project?.["optional-dependencies"])) {
    for (const [extra, lines] of Object.entries(doc.project["optional-dependencies"])) {
      addRequirements(found, `project.optional-dependencies.${extra}`, lines);
    }
  }
  if (isTable(doc["dependency-groups"])) {
    for (const [group, lines] of Object.entries(doc["dependency-groups"])) {
      addRequirements(found, `dependency-groups.${group}`, lines);
    }
  }
  addRequirements(found, "tool.uv.dev-dependencies", doc.tool?.uv?.["dev-dependencies"]);
  const poetry = doc.tool?.poetry;
  // `python` is the interpreter constraint, not a package.
  addTable(found, "tool.poetry.dependencies", poetry?.dependencies, ["python"]);
  addTable(found, "tool.poetry.dev-dependencies", poetry?.["dev-dependencies"], ["python"]);
  if (isTable(poetry?.group)) {
    for (const [group, body] of Object.entries(poetry.group)) {
      addTable(found, `tool.poetry.group.${group}.dependencies`, body?.dependencies, ["python"]);
    }
  }
  return found;
}
