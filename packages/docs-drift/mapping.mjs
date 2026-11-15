// mapping.mjs — which code a doc describes, worked out from the doc itself.
//
// Three rules, all of them visible in the result:
//   1. A path the doc mentions (a link target or an inline code span) that is a
//      tracked file, or a directory holding tracked files.
//   2. A README inside a directory describes that directory. A README at the
//      repository root is not taken to describe everything, so it maps only
//      through rule 1 and rule 3.
//   3. An identifier in an inline code span that looks like code (camelCase,
//      snake_case, `name()`) and appears in at most a few tracked files.
// Prose files (.md, .txt, ...) are never "code": a doc is judged against what it
// describes, not against its neighbours. Nothing here reads git or the disk; the caller passes
// the tracked file list and a `find` function for identifiers.

import { posix } from "node:path";

import { normalizeRel } from "../code-search/inventory.mjs";

const DOC_EXTENSION = /\.(?:md|mdx|markdown|rst|adoc|txt)$/i;
const README = /^readme(?:\.[a-z]+)?$/i;
const AGENT_FILES = new Set(["agents.md", "claude.md", "gemini.md"]);
const AGENT_PATHS = new Set([".github/copilot-instructions.md"]);

/** An identifier used in more files than this is too common to point at one place. */
const MAX_IDENTIFIER_FILES = 5;
const MAX_IDENTIFIERS = 20;
const MIN_IDENTIFIER_CHARS = 4;

/** Whether a repo-relative path is a doc this command judges. */
export function isDocPath(path) {
  const name = posix.basename(path);
  const lower = name.toLowerCase();
  if (AGENT_FILES.has(lower) || AGENT_PATHS.has(path.toLowerCase())) return true;
  if (!DOC_EXTENSION.test(name)) return false;
  if (README.test(name.replace(DOC_EXTENSION, ""))) return true;
  return path.split("/").slice(0, -1).includes("docs");
}

function withoutFences(text) {
  const kept = [];
  let fence = null;
  for (const line of String(text ?? "").split("\n")) {
    const mark = /^\s*(```|~~~)/.exec(line)?.[1];
    if (fence) {
      if (mark === fence) fence = null;
    } else if (mark) {
      fence = mark;
    } else {
      kept.push(line);
    }
  }
  return kept.join("\n");
}

function cleanPath(raw) {
  const path = raw
    .replace(/[#?].*$/, "")
    .replace(/:\d+(?::\d+)?$/, "")
    .replace(/^\.\//, "");
  if (!path || /[\s*<>|]|:\/\/|^mailto:/.test(path)) return null;
  return path;
}

const looksLikeCode = (name) => /[a-z][A-Z]|_/.test(name);

/**
 * The paths and identifiers a doc names: link targets and inline code outside
 * fenced blocks. Candidates only; whether they exist is for `mapDoc` to say.
 * @returns {{ paths: string[], identifiers: string[] }}
 */
export function docRefs(text) {
  const body = withoutFences(text);
  const paths = new Set();
  const identifiers = new Set();
  for (const match of body.matchAll(/\]\(\s*<?([^)\s>]+)/g)) {
    const path = cleanPath(match[1]);
    if (path) paths.add(path);
  }
  for (const match of body.matchAll(/`([^`\n]+)`/g)) {
    const span = match[1].trim();
    const identifier = /^([A-Za-z_$][\w$]*)(\(\))?$/.exec(span);
    if (identifier) {
      const [, name, call] = identifier;
      if (name.length >= MIN_IDENTIFIER_CHARS && (call || looksLikeCode(name))) {
        identifiers.add(name);
      }
      continue;
    }
    const path = cleanPath(span);
    if (path && (path.includes("/") || /\.\w{1,8}$/.test(path))) paths.add(path);
  }
  return { paths: [...paths], identifiers: [...identifiers] };
}

function directoriesOf(files) {
  const dirs = new Set();
  for (const file of files) {
    for (let dir = posix.dirname(file); dir !== "."; dir = posix.dirname(dir)) dirs.add(dir);
  }
  return dirs;
}

/**
 * The code a doc describes.
 * @param {{
 *   doc: string,
 *   text: string,
 *   files: Set<string>,
 *   find: (identifier: string) => Promise<string[]>,
 * }} input `files` is every tracked path; `find` lists the tracked files that use an identifier.
 * @returns {Promise<{ files: { path: string, via: string }[], dirs: string[] }>}
 */
export async function mapDoc({ doc, text, files, find }) {
  const dirs = directoriesOf(files);
  const code = (path) => files.has(path) && !DOC_EXTENSION.test(path);
  const mapped = new Map();
  const mappedDirs = new Set();
  const add = (path, via) => {
    if (code(path) && !mapped.has(path)) mapped.set(path, via);
  };
  const addDir = (dir, via) => {
    mappedDirs.add(dir);
    for (const file of files) if (file.startsWith(`${dir}/`)) add(file, via);
  };

  const refs = docRefs(text);
  for (const ref of refs.paths) {
    const candidates = ref.startsWith("/")
      ? [normalizeRel(ref)]
      : [normalizeRel(posix.join(posix.dirname(doc), ref)), normalizeRel(ref)];
    const hit = candidates.find((path) => path && (files.has(path) || dirs.has(path)));
    if (hit === undefined) continue;
    if (dirs.has(hit)) addDir(hit, "mentioned");
    else add(hit, "mentioned");
  }

  const here = posix.dirname(doc);
  if (README.test(posix.basename(doc).replace(/\.[^.]+$/, "")) && here !== ".") {
    addDir(here, "directory");
  }

  for (const name of refs.identifiers.slice(0, MAX_IDENTIFIERS)) {
    const hits = (await find(name)).filter(code);
    if (hits.length > 0 && hits.length <= MAX_IDENTIFIER_FILES) {
      for (const path of hits) add(path, `identifier ${name}`);
    }
  }

  return {
    files: [...mapped]
      .map(([path, via]) => ({ path, via }))
      .sort((a, b) => (a.path < b.path ? -1 : 1)),
    dirs: [...mappedDirs].sort(),
  };
}
