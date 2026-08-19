// resolve.mjs — find_definition engine: locate the definition of a symbol,
// resolving relative imports (with extension/index probing), tsconfig/jsconfig
// path aliases, workspace package names, and re-export chains (depth ≤ 8 with
// a cycle guard). Bare specifiers that don't match a workspace member are
// reported as external — node_modules is never scanned.
//
// Pure-ish: file existence is checked against the cache's file set; file
// reads (package.json for workspaces, context lines) are injected.

import { levenshtein } from "./search.mjs";
import { MAX_FILES } from "./inventory.mjs";

export const DEF_KINDS = new Set([
  "function", "class", "interface", "type", "enum",
  "const", "variable", "field", "method",
]);

const EXT_PROBE = [
  "", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".d.ts",
];
const REEXPORT_DEPTH = 8;

/** Parse tsconfig/jsconfig compilerOptions.paths + baseUrl. */
export function parseTsconfigPaths(json) {
  const compiler = json?.compilerOptions;
  if (!compiler || typeof compiler !== "object") return null;
  const paths = compiler.paths;
  if (!paths || typeof paths !== "object") return null;
  const entries = [];
  for (const [pattern, targets] of Object.entries(paths)) {
    const target = Array.isArray(targets) ? targets[0] : targets;
    if (typeof target === "string") entries.push({ pattern, target });
  }
  if (entries.length === 0) return null;
  const baseUrl = typeof compiler.baseUrl === "string"
    ? compiler.baseUrl.replace(/\/+$/, "")
    : "";
  return { baseUrl: baseUrl === "." ? "" : baseUrl, entries };
}

/**
 * Load the workspace name → dir map from root package.json `workspaces`.
 * @returns {Promise<Map<string, string>>}
 */
export async function loadWorkspaceMap({ files, readFile, json }) {
  const map = new Map();
  let patterns = [];
  if (json && typeof json === "object" && json.workspaces) {
    if (Array.isArray(json.workspaces)) patterns = json.workspaces;
    else if (typeof json.workspaces.packages === "object") patterns = json.workspaces.packages;
  }
  if (patterns.length === 0) return map;
  const dirs = new Set();
  const globRe = patterns.map((p) => globToDirRegex(String(p)));
  const fileSet = new Set(files);
  for (const rel of files) {
    const parts = rel.split("/");
    if (parts.length < 2) continue;
    // Candidate workspace member dirs: every directory prefix of a file that
    // has its own package.json.
    for (let k = 1; k < parts.length; k++) {
      const dir = parts.slice(0, k).join("/");
      if (dirs.has(dir)) continue;
      if (!fileSet.has(`${dir}/package.json`)) continue;
      if (globRe.some((re) => re.test(dir))) dirs.add(dir);
    }
  }
  for (const dir of dirs) {
    try {
      const text = await readFile(`${dir}/package.json`);
      const name = JSON.parse(text)?.name;
      if (typeof name === "string" && name) map.set(name, dir);
    } catch {
      // skip unreadable/parse-failing member manifests
    }
  }
  return map;
}

/** Workspace glob (`packages/*`, `apps/**`) → dir-matching RegExp. */
function globToDirRegex(glob) {
  let body = String(glob).replace(/\/+$/, "");
  let out = "";
  let i = 0;
  while (i < body.length) {
    const c = body[i];
    if (c === "*") {
      let j = i;
      while (j < body.length && body[j] === "*") j++;
      const count = j - i;
      if (count >= 2) out += ".*";
      else out += "[^/]+";
      i = j;
    } else if (c === "?") {
      out += "[^/]";
      i++;
    } else if (c === ".") {
      out += "\\.";
      i++;
    } else {
      out += c;
      i++;
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Resolve a module specifier to a repo-relative file, probing extensions and
 * index files against the file set.
 * @returns {{ type: "file", rel: string } | { type: "external", pkg: string } | { type: "unresolved", reason: string }}
 */
export function resolveSpecifier(spec, fromRel, { fileSet, tsconfig, workspaceMap }) {
  const raw = String(spec ?? "");
  if (!raw) return { type: "unresolved", reason: "empty specifier" };

  const probe = (base) => {
    if (fileSet.has(base)) return base;
    for (const ext of EXT_PROBE) {
      if (!ext) continue;
      if (fileSet.has(base + ext)) return base + ext;
    }
    for (const ext of EXT_PROBE) {
      if (fileSet.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
    }
    return null;
  };

  const dirName = (rel) => {
    const idx = rel.lastIndexOf("/");
    return idx < 0 ? "" : rel.slice(0, idx);
  };

  // Relative specifier
  if (raw.startsWith("./") || raw.startsWith("../")) {
    const base = dirName(fromRel);
    const parts = [];
    for (const seg of raw.split("/")) {
      if (seg === "." || seg === "") continue;
      if (seg === "..") parts.pop();
      else parts.push(seg);
    }
    const joined = [...(base ? base.split("/") : []), ...parts].join("/");
    const hit = probe(joined);
    if (hit) return { type: "file", rel: hit };
    return { type: "unresolved", reason: `no local file for "${raw}" (probed from ${fromRel})` };
  }

  // tsconfig/jsconfig path alias (@/lib/x, ~/foo, lib/*) — try entries from
  // longest prefix to shortest, probing each target in the file set.
  if (tsconfig) {
    const baseUrl = tsconfig.baseUrl ? `${tsconfig.baseUrl.replace(/^\/+/, "")}/` : "";
    const entries = [...tsconfig.entries].sort(
      (a, b) => b.pattern.replace(/\*$/, "").length - a.pattern.replace(/\*$/, "").length,
    );
    for (const { pattern, target } of entries) {
      let rel = null;
      if (pattern.endsWith("*") && raw.startsWith(pattern.slice(0, -1))) {
        const star = raw.slice(pattern.length - 1);
        rel = `${baseUrl}${target.replace("*", star)}`.replace(/\/+/g, "/");
      } else if (pattern === raw) {
        rel = `${baseUrl}${target}`.replace(/\/+/g, "/");
      }
      if (rel) {
        const hit = probe(rel);
        if (hit) return { type: "file", rel: hit };
      }
    }
  }

  // Workspace package name
  if (workspaceMap?.has(raw)) {
    const dir = workspaceMap.get(raw);
    const entry = probe(`${dir}/src/index`);
    if (entry) return { type: "file", rel: entry };
    const entry2 = probe(`${dir}/index`);
    if (entry2) return { type: "file", rel: entry2 };
    const pkgEntry = probe(`${dir}/package.json`);
    if (pkgEntry && fileSet.has(pkgEntry)) {
      return { type: "file", rel: pkgEntry }; // caller may read main/types
    }
    return { type: "unresolved", reason: `workspace member "${raw}" has no resolvable entry` };
  }

  // Bare specifier not in workspaces → external
  const pkg = raw.startsWith("@") ? raw.split("/").slice(0, 2).join("/") : raw.split("/")[0];
  return { type: "external", pkg };
}

/**
 * Find definition candidates for `symbol`.
 * @param {object} opts
 * @param {string} opts.symbol
 * @param {string} [opts.fromFile]   repo-relative path to resolve imports from
 * @param {string} [opts.kind]       optional kind filter
 * @param {object} opts.cache        cache object
 * @param {object|null} opts.tsconfig
 * @param {Map|null} opts.workspaceMap
 * @param {(rel: string) => Promise<string | null>} opts.readFile
 * @returns {Promise<{ external: string | null, candidates: Array, note: string | null, primaryRel: string | null }>}
 */
export async function resolveDefinition({
  symbol,
  fromFile,
  kind,
  cache,
  tsconfig,
  workspaceMap,
  readFile,
}) {
  const files = Object.keys(cache?.files ?? {});
  const fileSet = new Set(files);
  const note = [];
  let external = null;
  let primaryRel = null;

  // --- Step 1: resolve via the fromFile's imports/reexports -----------------
  if (fromFile) {
    const entry = cache.files[fromFile];
    if (entry) {
      let targetSpec = null;
      let targetName = symbol;
      const importRec = entry.imports?.find((r) => r.names?.some((nm) => nm.local === symbol));
      if (importRec) {
        targetSpec = importRec.source;
        const nm = importRec.names.find((n) => n.local === symbol);
        targetName = nm?.imported ?? symbol;
      } else {
        const re = entry.reexports?.find(
          (r) => r.names === null || r.names?.some((nm) => nm.local === symbol),
        );
        if (re) {
          targetSpec = re.source;
          const nm = re.names?.find((n) => n.local === symbol);
          targetName = nm?.imported ?? symbol;
        }
      }
      if (targetSpec) {
        const resolved = resolveSpecifier(targetSpec, fromFile, { fileSet, tsconfig, workspaceMap });
        if (resolved.type === "file") {
          const followed = followReexports(resolved.rel, targetName, {
            cache, fileSet, tsconfig, workspaceMap, depth: 0, visited: new Set(),
            alsoName: symbol, // default imports resolve to the function's own name
          });
          if (followed?.rel) {
            primaryRel = followed.rel;
          } else if (followed?.external) {
            external = followed.external;
            if (importRec) note.push(`imported from "${importRec.source}" (re-exported)`);
          } else {
            note.push(`import of "${symbol}" from "${targetSpec}" resolved to ${resolved.rel} but no definition found there`);
          }
        } else if (resolved.type === "external") {
          external = resolved.pkg;
          if (importRec) note.push(`imported from "${importRec.source}"`);
        } else {
          note.push(`could not resolve "${targetSpec}" — ${resolved.reason}`);
        }
      }
    } else {
      note.push(`fromFile "${fromFile}" not found in the inventory`);
    }
  }

  // --- Step 2: global scan for definitions ---------------------------------
  const q = String(symbol ?? "").toLowerCase();
  const candidates = [];
  for (const rel of files) {
    const entry = cache.files[rel];
    if (entry?.symbolsDropped) continue;
    for (const s of entry?.symbols ?? []) {
      if (s.name !== symbol) continue;
      if (kind && s.kind !== kind) continue;
      if (!DEF_KINDS.has(s.kind)) continue;
      candidates.push({ rel, line: s.startLine, name: s.name, kind: s.kind, signature: s.signature, exported: !!s.exported });
    }
  }
  candidates.sort((a, b) => {
    if (a.rel === primaryRel) return -1;
    if (b.rel === primaryRel) return 1;
    if (a.exported !== b.exported) return a.exported ? -1 : 1;
    return a.rel.localeCompare(b.rel) || a.line - b.line;
  });

  // Attach 2-line context around each candidate's definition line.
  const withContext = [];
  for (const c of candidates.slice(0, 8)) {
    const lines = (await readFile(c.rel))?.split(/\r?\n/) ?? [];
    const lo = Math.max(0, c.line - 2);
    const hi = Math.min(lines.length, c.line + 1);
    c.context = lines.slice(lo, hi).map((l) => l.trim().slice(0, 100)).filter(Boolean);
    withContext.push(c);
  }

  if (candidates.length === 0 && !external) {
    const suggestions = await suggestDefs(q, files, cache);
    if (suggestions.length > 0) note.push(`no definition found — did you mean: ${suggestions.join(", ")}?`);
  }

  return {
    external,
    candidates: withContext,
    note: note.length ? note.join("; ") : null,
    primaryRel,
  };
}

/** Follow a re-export chain from `startRel` looking for `name`. */
function followReexports(startRel, name, { cache, fileSet, tsconfig, workspaceMap, depth, visited, alsoName }) {
  if (depth > REEXPORT_DEPTH || visited.has(startRel)) return null;
  visited.add(startRel);
  const entry = cache.files[startRel];
  if (!entry) return null;

  // Definition here? (alsoName covers `import X from ...` where the source
  // default export is a named function rather than an anonymous `default`.)
  const def = entry.symbols?.find(
    (s) => (s.name === name || (alsoName && s.name === alsoName)) && DEF_KINDS.has(s.kind),
  );
  if (def) return { rel: startRel };

  // Re-exports here? (records carry { imported, local })
  const re = entry.reexports?.find(
    (r) => r.names === null || r.names?.some((nm) => nm.imported === name || nm.local === name),
  );
  if (re?.source) {
    const resolved = resolveSpecifier(re.source, startRel, { fileSet, tsconfig, workspaceMap });
    if (resolved.type === "file") {
      const nm = re.names?.find((n) => n.imported === name || n.local === name);
      const nextName = nm ? nm.imported : name;
      return followReexports(resolved.rel, nextName, {
        cache, fileSet, tsconfig, workspaceMap, depth: depth + 1, visited,
      });
    }
    if (resolved.type === "external") return { external: resolved.pkg };
  }
  return null;
}

async function suggestDefs(q, files, cache) {
  const seen = new Set();
  for (const rel of files) {
    for (const s of cache.files[rel]?.symbols ?? []) {
      const name = s.name?.toLowerCase();
      if (!name || seen.has(name)) continue;
      if (levenshtein(q, name) <= 2 && name !== q) seen.add(name);
    }
  }
  return [...seen].sort((a, b) => levenshtein(q, a) - levenshtein(q, b)).slice(0, 3);
}

export { MAX_FILES };
