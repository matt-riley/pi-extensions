// resolve.mjs — find_definition engine: locate the definition of a symbol,
// following imports and re-export chains (depth ≤ 8 with a cycle guard) to the
// file that defines it. Turning a specifier into a file is the import graph's job
// (shared/import-graph.mjs): relative paths, tsconfig/jsconfig aliases, workspace
// packages, and external packages that are never scanned.
//
// Pure-ish: the cache and the import graph are passed in; file reads (context
// lines) are injected.

import { suggestSymbols } from "./search.mjs";

const DEF_KINDS = new Set([
  "function",
  "class",
  "interface",
  "type",
  "enum",
  "const",
  "variable",
  "field",
  "method",
]);

const REEXPORT_DEPTH = 8;

/**
 * Find definition candidates for `symbol`.
 * @param {object} opts
 * @param {string} opts.symbol
 * @param {string} [opts.fromFile]   repo-relative path to resolve imports from
 * @param {string} [opts.kind]       optional kind filter
 * @param {object} opts.cache        cache object
 * @param {{ resolve: (spec: string, fromRel: string) => object }} opts.graph  import graph (shared/import-graph.mjs)
 * @param {(rel: string) => Promise<string | null>} opts.readFile
 * @returns {Promise<{ external: string | null, candidates: Array, note: string | null, primaryRel: string | null }>}
 */
export async function resolveDefinition({ symbol, fromFile, kind, cache, graph, readFile }) {
  const files = Object.keys(cache?.files ?? {});
  const note = [];
  let external = null;
  let primaryRel = null;

  // --- Step 1: resolve via the fromFile's imports/reexports -----------------
  if (fromFile) {
    const found = resolveFromFile({ symbol, fromFile, cache, graph, note });
    external = found.external ?? null;
    primaryRel = found.primaryRel ?? null;
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
      candidates.push({
        rel,
        line: s.startLine,
        name: s.name,
        kind: s.kind,
        signature: s.signature,
        exported: !!s.exported,
      });
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
    c.context = lines
      .slice(lo, hi)
      .map((l) => l.trim().slice(0, 100))
      .filter(Boolean);
    withContext.push(c);
  }

  if (candidates.length === 0 && !external) {
    const suggestions = suggestSymbols(q, files, cache);
    if (suggestions.length > 0)
      note.push(`no definition found — did you mean: ${suggestions.join(", ")}?`);
  }

  return {
    external,
    candidates: withContext,
    note: note.length ? note.join("; ") : null,
    primaryRel,
  };
}

/**
 * Resolve `symbol` through the imports and re-exports declared by `fromFile`.
 * Returns the file that defines it, or the package it comes from. Explanations
 * for an unresolved symbol are appended to `note`.
 */
function resolveFromFile({ symbol, fromFile, cache, graph, note }) {
  const entry = cache.files[fromFile];
  if (!entry) {
    note.push(`fromFile "${fromFile}" not found in the inventory`);
    return {};
  }

  const importRec = entry.imports?.find((r) => r.names?.some((nm) => nm.local === symbol));
  let targetSpec = null;
  let targetName = symbol;
  if (importRec) {
    targetSpec = importRec.source;
    targetName = importRec.names.find((n) => n.local === symbol)?.imported ?? symbol;
  } else {
    const re = entry.reexports?.find(
      (r) => r.names === null || r.names?.some((nm) => nm.local === symbol),
    );
    if (re) {
      targetSpec = re.source;
      targetName = re.names?.find((n) => n.local === symbol)?.imported ?? symbol;
    }
  }
  if (!targetSpec) return {};

  const resolved = graph.resolve(targetSpec, fromFile);
  if (resolved.type === "external") {
    if (importRec) note.push(`imported from "${importRec.source}"`);
    return { external: resolved.pkg };
  }
  if (resolved.type !== "file") {
    note.push(`could not resolve "${targetSpec}" — ${resolved.reason}`);
    return {};
  }

  const followed = followReexports(resolved.rel, targetName, {
    cache,
    graph,
    depth: 0,
    visited: new Set(),
    alsoName: symbol, // default imports resolve to the function's own name
  });
  if (followed?.rel) return { primaryRel: followed.rel };
  if (followed?.external) {
    if (importRec) note.push(`imported from "${importRec.source}" (re-exported)`);
    return { external: followed.external };
  }
  note.push(
    `import of "${symbol}" from "${targetSpec}" resolved to ${resolved.rel} but no definition found there`,
  );
  return {};
}

/** Follow a re-export chain from `startRel` looking for `name`. */
function followReexports(startRel, name, { cache, graph, depth, visited, alsoName }) {
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
    const resolved = graph.resolve(re.source, startRel);
    if (resolved.type === "file") {
      const nm = re.names?.find((n) => n.imported === name || n.local === name);
      const nextName = nm ? nm.imported : name;
      return followReexports(resolved.rel, nextName, {
        cache,
        graph,
        depth: depth + 1,
        visited,
      });
    }
    if (resolved.type === "external") return { external: resolved.pkg };
  }
  return null;
}
