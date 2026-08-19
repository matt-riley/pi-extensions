// inventory.mjs — repo boundary + file inventory.
//
// Git-aware when possible: the root is `git rev-parse --show-toplevel` and the
// inventory is `git ls-files --cached --others --exclude-standard` (tracked +
// untracked, gitignore-exact). Falls back to a pure-node walker with the
// hand-rolled gitignore matcher when git is unavailable or the dir is not a
// repo. node_modules, .git, and the .pi/cache dir are always excluded.
//
// `exec` is injected (pi.exec from index.ts, a fake in tests) so this module
// stays plain .mjs and testable with node --test.

import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { collectRules, matchPath, parseGitignore } from "./gitignore.mjs";

export const MAX_FILES = 50_000;

// Path prefixes (relative to repo root) always excluded from the inventory,
// regardless of git state: third-party deps, the repo's own git dir, and our
// own cache.
export const ALWAYS_EXCLUDED_PREFIXES = ["node_modules", ".git", ".pi/cache"];

export function isExcludedPath(relPath) {
  for (const prefix of ALWAYS_EXCLUDED_PREFIXES) {
    if (relPath === prefix || relPath.startsWith(prefix + "/")) return true;
  }
  return false;
}

/** Normalize a repo-relative path to posix form without leading "./". */
export function normalizeRel(relPath) {
  const parts = String(relPath ?? "")
    .split(/[\\/]/)
    .filter((p) => p.length > 0 && p !== ".");
  const out = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

/**
 * Determine the repo root for `cwd`.
 * @returns {Promise<{ root: string, viaGit: boolean }>}
 */
export async function findRepoRoot(cwd, exec) {
  try {
    if (exec) {
      const result = await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { timeout: 5000 });
      const root = String(result?.stdout ?? "").trim();
      if (result?.code === 0 && root && !/[\r\n]/.test(root)) {
        return { root, viaGit: true };
      }
    }
  } catch {
    // fall through to cwd
  }
  return { root: cwd, viaGit: false };
}

/**
 * List repo-relative file paths (posix, no leading "./").
 * @returns {Promise<{ files: string[], viaGit: boolean, truncated: boolean }>}
 */
export async function listRepoFiles({ root, exec }) {
  if (exec) {
    try {
      const result = await exec(
        "git",
        ["-C", root, "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
        { timeout: 15_000 },
      );
      if (result?.code === 0) {
        const raw = String(result.stdout ?? "");
        const files = raw
          .split("\0")
          .map((p) => normalizeRel(p))
          .filter((p) => p.length > 0 && !isExcludedPath(p));
        return { files: capFiles(files), viaGit: true, truncated: files.length > MAX_FILES };
      }
    } catch {
      // fall through to the walker
    }
  }
  const files = await walkRoot(root);
  return { files: capFiles(files), viaGit: false, truncated: files.length > MAX_FILES };
}

function capFiles(files) {
  return files.length > MAX_FILES ? files.slice(0, MAX_FILES) : files;
}

/**
 * Pure-node fallback: walk `rootDir` respecting .gitignore files (root,
 * nested, .git/info/exclude, global excludes). Does not follow directory
 * symlinks. Returns rel paths.
 */
export async function walkRoot(rootDir) {
  const files = [];
  const readFileForRules = (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  };
  // Static rule set: global excludes + .git/info/exclude + root .gitignore
  // (collectRules now includes the root .gitignore itself).
  const rules = collectRules({ rootDir, readFile: readFileForRules });

  async function walk(dir, relDir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const nestedGitignore = entries.find((e) => e.isFile() && e.name === ".gitignore");
    if (nestedGitignore) {
      const text = readFileForRules(`${dir}/.gitignore`);
      if (text != null) {
        rules.push(...parseGitignore(text, { base: relDir, source: `${relDir}/.gitignore` }));
      }
    }
    for (const entry of entries) {
      if (entry.name === ".git" || entry.name === ".gitignore") continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (isExcludedPath(rel)) continue;
      const isDir = entry.isDirectory();
      if (isDir && entry.isSymbolicLink()) continue; // skip dir symlinks (cycles)
      if (matchPath(rel, isDir, rules)) continue;
      if (isDir) {
        await walk(`${dir}/${entry.name}`, rel);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(rel);
      }
    }
  }

  await walk(rootDir, "");
  return files;
}
