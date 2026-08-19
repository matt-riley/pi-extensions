// format.mjs — pure result formatters for the four tools. Everything here is
// deterministic and testable: tree building, language breakdowns, and the
// markdown-ish text each tool returns (with output caps).

import { enclosingSymbol } from "./search.mjs";

const REPO_MAP_LINE_CAP = 150;
const TREE_LINE_CAP = 60;
const KEY_FILES = [
  "README.md", "README.txt", "README", "AGENTS.md", "CLAUDE.md",
  "LICENSE", "LICENSE.md", "LICENSE.txt",
  "package.json", "tsconfig.json", "jsconfig.json", "pyproject.toml",
  "Cargo.toml", "go.mod", "Gemfile", "pom.xml", "build.gradle",
  "deno.json", "deno.jsonc", "Makefile", "Dockerfile",
  "docker-compose.yml", "compose.yaml", "compose.yml",
  ".env.example", "vitest.config.ts", "vitest.config.js", "jest.config.ts",
  "jest.config.js", "eslint.config.js", "eslint.config.mjs", ".eslintrc.js",
  ".prettierrc", ".prettierrc.json", "biome.json", "turbo.json", "nx.json",
  "lerna.json", "pnpm-workspace.yaml",
];

const MANIFEST_KEYS = ["package.json", "pyproject.toml", "Cargo.toml", "go.mod", "deno.json", "deno.jsonc"];

export function fmtBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/** Top languages by file count. */
export function languageBreakdown(files) {
  const counts = new Map();
  for (const rel of files) {
    const dot = rel.lastIndexOf(".");
    const ext = dot > 0 ? rel.slice(dot + 1).toLowerCase() : "?";
    counts.set(ext, (counts.get(ext) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
}

/**
 * Compact tree lines for the repo map. Dirs collapse with a file count when
 * they have too many entries at the expansion frontier.
 */
export function buildTreeLines(files, depth) {
  const maxDepth = Math.max(1, Math.min(4, Number(depth) || 2));
  const dirs = new Map();
  const topFiles = [];
  for (const rel of files) {
    const parts = rel.split("/");
    if (parts.length === 1) {
      topFiles.push(rel);
    } else {
      const dir = parts[0];
      if (!dirs.has(dir)) dirs.set(dir, []);
      dirs.get(dir).push(parts.slice(1).join("/"));
    }
  }
  const lines = [];
  const sortedDirs = [...dirs.keys()].sort();
  const sortedFiles = topFiles.sort();

  const renderDir = (name, subFiles, level) => {
    const count = subFiles.length;
    if (level >= maxDepth || count > 20) {
      lines.push(`${"  ".repeat(level)}${name}/ (${count} files)`);
      return;
    }
    lines.push(`${"  ".repeat(level)}${name}/`);
    const subDirs = new Map();
    const direct = [];
    for (const rel of subFiles) {
      const parts = rel.split("/");
      if (parts.length === 1) direct.push(rel);
      else {
        const d = parts[0];
        if (!subDirs.has(d)) subDirs.set(d, []);
        subDirs.get(d).push(parts.slice(1).join("/"));
      }
    }
    for (const d of [...subDirs.keys()].sort()) {
      renderDir(d, subDirs.get(d), level + 1);
      if (lines.length > TREE_LINE_CAP) return;
    }
    for (const f of direct.sort()) {
      lines.push(`${"  ".repeat(level + 1)}${f}`);
      if (lines.length > TREE_LINE_CAP) return;
    }
  };

  for (const d of sortedDirs) {
    renderDir(d, dirs.get(d), 0);
    if (lines.length > TREE_LINE_CAP) break;
  }
  for (const f of sortedFiles) {
    lines.push(f);
    if (lines.length > TREE_LINE_CAP) break;
  }
  return lines;
}

/** Detect key files present in the inventory. */
export function findKeyFiles(files) {
  const found = [];
  const lower = new Set(files.map((f) => f.toLowerCase()));
  for (const key of KEY_FILES) {
    if (lower.has(key.toLowerCase())) found.push(key);
  }
  // GitHub Actions workflows
  for (const f of files) {
    if (/^\.github\/workflows\/.+\.ya?ml$/i.test(f) && found.length < 12) found.push(f);
  }
  return found.slice(0, 12);
}

export function findTestFiles(files) {
  return files
    .filter((f) => /(^|\/)(test|tests|__tests__)\//.test(f) || /\.(test|spec)\./.test(f))
    .slice(0, 10);
}

/** package.json highlights for the map. */
export function packageHighlights(relPath, json) {
  if (!json || typeof json !== "object") return null;
  const lines = [];
  if (json.name) lines.push(`name: ${json.name}`);
  if (json.version) lines.push(`version: ${json.version}`);
  if (json.description) lines.push(`description: ${String(json.description).slice(0, 120)}`);
  if (json.scripts && typeof json.scripts === "object") {
    const entries = Object.entries(json.scripts).slice(0, 10);
    lines.push(`scripts (${Object.keys(json.scripts).length}):`);
    for (const [k, v] of entries) lines.push(`  ${k}: ${v}`);
  }
  const entry = json.main ?? json.module ?? json.types;
  if (entry) lines.push(`entry: ${entry}`);
  if (json.packageManager) lines.push(`packageManager: ${json.packageManager}`);
  if (json.workspaces) lines.push(`workspaces: ${Array.isArray(json.workspaces) ? json.workspaces.join(", ") : "yes"}`);
  const deps = Object.keys(json.dependencies ?? {}).length;
  const devDeps = Object.keys(json.devDependencies ?? {}).length;
  if (deps || devDeps) lines.push(`deps: ${deps} runtime, ${devDeps} dev`);
  return lines.length ? lines : null;
}

/** Assemble the full repo_map text. */
export function formatRepoMap({
  root, branch, viaGit, files, truncated,
  languages, tree, keyFiles, testFiles, pkg,
  newest, largest, symbolCount,
}) {
  const out = [];
  out.push(`# Repo map — ${root}`);
  out.push(`files: ${files.length}${truncated ? ` (capped at ${files.length})` : ""}  ·  size: ${fmtBytes(files.reduce((s, f) => s + (f.size ?? 0), 0))}  ·  symbols indexed: ${symbolCount}`);
  if (branch) out.push(`branch: ${branch}`);
  if (!viaGit) out.push(`(not a git repo — pure-node walker inventory)`);
  out.push("");
  out.push("## Languages (by file count)");
  if (languages.length === 0) out.push("(none)");
  else out.push(languages.map(([ext, n]) => `${ext || "?"}: ${n}`).join("  ·  "));
  out.push("");
  out.push("## Tree");
  if (tree.length === 0) out.push("(empty repo)");
  out.push(...tree);
  out.push("");
  if (keyFiles.length > 0) {
    out.push("## Key files");
    out.push(keyFiles.map((f) => `- ${f}`).join("\n"));
    out.push("");
  }
  if (pkg) {
    out.push("## package.json");
    out.push(pkg.join("\n"));
    out.push("");
  }
  if (testFiles.length > 0) {
    out.push("## Test files (first 10)");
    out.push(testFiles.map((f) => `- ${f}`).join("\n"));
    out.push("");
  }
  if (newest.length > 0) {
    out.push("## Recently modified");
    for (const f of newest) out.push(`- ${f.rel} (${fmtBytes(f.size)})`);
    out.push("");
  }
  if (largest.length > 0) {
    out.push("## Largest files");
    for (const f of largest) out.push(`- ${f.rel} (${fmtBytes(f.size)})`);
  }
  const text = out.join("\n").trimEnd();
  const lines = text.split("\n");
  return lines.length > REPO_MAP_LINE_CAP
    ? `${lines.slice(0, REPO_MAP_LINE_CAP).join("\n")}\n… (map truncated at ${REPO_MAP_LINE_CAP} lines)`
    : text;
}

const OUTLINE_CAP = 200;
const SIG_CAP = 120;

/** file_outline text for one file's symbols. */
export function formatOutline({ relPath, symbols, truncated }) {
  const out = [`# Outline — ${relPath}`];
  const sorted = [...symbols].sort((a, b) => a.startLine - b.startLine || (a.col ?? 0) - (b.col ?? 0));
  const shown = sorted.slice(0, OUTLINE_CAP);
  for (const s of shown) {
    let sig = (s.signature ?? "").replace(/\s+/g, " ").trim().slice(0, SIG_CAP);
    // Drop a redundant "kind name" prefix when the signature repeats it
    // (e.g. `interface UiCtx` → the outline already prints kind + name).
    const prefix = `${s.kind} ${s.name}`;
    if (sig.startsWith(prefix)) sig = sig.slice(prefix.length).trim();
    out.push(`L${s.startLine}  ${s.kind} ${s.name}${sig ? `  ${sig}` : ""}`);
  }
  if (truncated || sorted.length > shown.length) {
    out.push(`… (${sorted.length - shown.length} more symbols)`);
  }
  return out.join("\n");
}

/** Frame a search hit with its enclosing symbol. */
export function frameHit(hit) {
  const sym = enclosingSymbol(hit.entry, hit.lineNo);
  if (!sym) return null;
  const sig = (sym.signature ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  const range = sym.endLine >= 0 ? `lines ${sym.startLine}–${sym.endLine}` : `starts line ${sym.startLine}`;
  return `in ${sym.kind} ${sym.name}${sig ? ` ${sig}` : ""} (${range})`;
}

/** code_search result text. */
export function formatSearchHits({ query, hits, total, truncated, suggestion }) {
  const out = [`# code_search "${query}" — ${total} match${total === 1 ? "" : "es"}`];
  for (const h of hits) {
    out.push(`${h.rel}:${h.lineNo}:${h.col}`);
    const frame = frameHit(h);
    if (frame) out.push(`  ${frame}`);
    const text = h.text.trim().replace(/\s+/g, " ").slice(0, 160);
    if (text) out.push(`  ${text}`);
  }
  if (truncated && total > hits.length) {
    out.push(`… and ${total - hits.length} more matches — narrow with path=<dir> or a more specific query.`);
  }
  if (suggestion?.length > 0) {
    out.push(`No matches for "${query}" — did you mean: ${suggestion.join(", ")}?`);
  }
  return out.join("\n");
}

/** find_definition result text. */
export function formatDefinitions({ symbol, external, candidates, note }) {
  const out = [`# find_definition "${symbol}"`];
  if (external) {
    out.push(`external: ${external} — not indexed (node_modules excluded)`);
  }
  if (note) out.push(note);
  for (const c of candidates.slice(0, 3)) {
    out.push(`${c.rel}:${c.line}  ${c.kind} ${c.name}${c.signature ? `  ${c.signature.replace(/\s+/g, " ").trim().slice(0, 100)}` : ""}${c.exported ? "  (exported)" : ""}`);
    if (c.context && c.context.length > 0) {
      for (const line of c.context) out.push(`  | ${line}`);
    }
  }
  if (candidates.length > 3) {
    out.push(`… and ${candidates.length - 3} more candidates`);
  }
  return out.join("\n");
}
