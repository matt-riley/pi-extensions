// import-graph.mjs — how a repository's modules point at each other.
//
// One place that knows how a specifier becomes a file: relative paths with
// extension and index probing, tsconfig/jsconfig `paths` aliases, workspace
// package names. Bare specifiers that are not workspace members are reported as
// external; node_modules is never looked into.
//
// Pure: file existence is checked against the file list it is given, and the
// few files it needs to read (tsconfig.json, package.json and the workspace
// members' manifests) come through an injected `readFile`.

const EXT_PROBE = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts", ".d.ts"];

/** Parse tsconfig/jsconfig compilerOptions.paths + baseUrl. */
function parseTsconfigPaths(json) {
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
  const baseUrl = typeof compiler.baseUrl === "string" ? compiler.baseUrl.replace(/\/+$/, "") : "";
  return { baseUrl: baseUrl === "." ? "" : baseUrl, entries };
}

/**
 * Load the workspace name → dir map from root package.json `workspaces`.
 * @returns {Promise<Map<string, string>>}
 */
async function loadWorkspaceMap({ files, readFile, json }) {
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
function resolveSpecifier(spec, fromRel, { fileSet, tsconfig, workspaceMap }) {
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
    // Walk from the importing file's directory: `..` climbs out of it.
    const parts = dirName(fromRel).split("/").filter(Boolean);
    for (const seg of raw.split("/")) {
      if (seg === "." || seg === "") continue;
      if (seg === "..") {
        if (parts.length === 0) {
          return { type: "unresolved", reason: `"${raw}" climbs above the repository root` };
        }
        parts.pop();
      } else parts.push(seg);
    }
    const joined = parts.join("/");
    const hit = probe(joined);
    if (hit) return { type: "file", rel: hit };
    return { type: "unresolved", reason: `no local file for "${raw}" (probed from ${fromRel})` };
  }

  // tsconfig/jsconfig path alias (@/lib/x, ~/foo, lib/*) — try entries from
  // longest prefix to shortest, probing each target in the file set.
  let aliasMatched = false;
  if (tsconfig) {
    const baseUrl = tsconfig.baseUrl ? `${tsconfig.baseUrl.replace(/^\/+/, "")}/` : "";
    const entries = [...tsconfig.entries].sort(
      (a, b) => b.pattern.replace(/\*$/, "").length - a.pattern.replace(/\*$/, "").length,
    );
    for (const { pattern, target } of entries) {
      let rel = null;
      if (pattern.endsWith("*") && raw.startsWith(pattern.slice(0, -1))) {
        const star = raw.slice(pattern.length - 1);
        // The first `*` only: tsconfig allows one per target.
        const at = target.indexOf("*");
        const filled = at < 0 ? target : target.slice(0, at) + star + target.slice(at + 1);
        rel = `${baseUrl}${filled}`.replace(/\/+/g, "/");
      } else if (pattern === raw) {
        rel = `${baseUrl}${target}`.replace(/\/+/g, "/");
      }
      if (rel) {
        aliasMatched = true;
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

  // A paths pattern claimed it but no file backs it: a broken alias, not a package.
  if (aliasMatched)
    return { type: "unresolved", reason: `alias "${raw}" matches a paths entry but no file` };

  // Bare specifier not in workspaces → external
  const pkg = raw.startsWith("@") ? raw.split("/").slice(0, 2).join("/") : raw.split("/")[0];
  return { type: "external", pkg };
}

/**
 * The import graph of a repository: a resolver for its specifiers.
 *
 * @param {{ files: string[], readFile: (rel: string) => Promise<string | null> }} opts
 *   `files` is every repo-relative path; `readFile` returns a file's text or null.
 * @returns {Promise<{
 *   files: Set<string>,
 *   resolve: (spec: string, fromRel: string) =>
 *     { type: "file", rel: string } | { type: "external", pkg: string } | { type: "unresolved", reason: string },
 * }>}
 */
export async function loadImportGraph({ files, readFile }) {
  const fileSet = new Set(files);
  const readJson = async (names) => {
    for (const name of names) {
      try {
        const text = await readFile(name);
        if (text != null) return JSON.parse(text);
      } catch {
        // try the next name
      }
    }
    return null;
  };
  const tsconfig = parseTsconfigPaths(await readJson(["tsconfig.json", "jsconfig.json"]));
  const workspaceMap = await loadWorkspaceMap({
    files,
    readFile,
    json: await readJson(["package.json"]),
  });
  return {
    files: fileSet,
    resolve: (spec, fromRel) =>
      resolveSpecifier(spec, fromRel, { fileSet, tsconfig, workspaceMap }),
  };
}

const DEFAULT_MAX_FILES = 5_000;
const DEFAULT_MAX_BYTES = 1_000_000;

/**
 * Every import edge in the repository, plus an honest list of what could not be
 * followed. Nothing here is guessed: an import that cannot be turned into a file
 * is reported, not dropped.
 *
 * `parse(text, rel)` is injected (code-search's `parseTsSource` fits) and returns
 * `{ imports, reexports, dynamicImports }`. Each edge is
 * `{ from, to, kind, line }` with kind `static`, `type` (import type), `reexport`
 * or `dynamic` (a literal `import("./x")`). Bare packages are external and not
 * listed. `incomplete` entries are `{ kind, file, line, detail }`, kind one of
 * `dynamic-import` (every `import()`; `literal` and `resolved` say whether it named a
 * file and whether that file was found), `unresolved`,
 * `unreadable`, `too-large`, `unparseable`, `file-cap`.
 *
 * Output order depends only on the file names and contents.
 *
 * @param {{
 *   graph: Awaited<ReturnType<typeof loadImportGraph>>,
 *   files: string[],
 *   readFile: (rel: string) => Promise<string | null>,
 *   parse: (text: string, rel: string) => object,
 *   maxFiles?: number,
 *   maxBytes?: number,
 * }} opts
 */
export async function collectEdges({
  graph,
  files,
  readFile,
  parse,
  maxFiles = DEFAULT_MAX_FILES,
  maxBytes = DEFAULT_MAX_BYTES,
}) {
  const sorted = [...new Set(files)].sort();
  const scan = sorted.slice(0, maxFiles);
  const edges = [];
  const incomplete = [];

  for (const file of scan) {
    const text = await readFile(file).catch(() => null);
    if (text == null) {
      incomplete.push({ kind: "unreadable", file, line: null, detail: "could not be read" });
      continue;
    }
    if (text.length > maxBytes) {
      incomplete.push({
        kind: "too-large",
        file,
        line: null,
        detail: `${text.length} characters, over the ${maxBytes} limit`,
      });
      continue;
    }
    let parsed;
    try {
      parsed = parse(text, file);
    } catch (error) {
      incomplete.push({
        kind: "unparseable",
        file,
        line: null,
        detail: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const found = [];
    const follow = (specifier, kind, line) => {
      const result = graph.resolve(specifier, file);
      if (result.type === "file") found.push({ edge: { from: file, to: result.rel, kind, line } });
      else if (result.type === "unresolved" && kind !== "dynamic") {
        found.push({ gap: { kind: "unresolved", file, line, detail: result.reason } });
      }
    };
    for (const record of parsed.imports ?? []) {
      if (record.source) follow(record.source, record.typeOnly ? "type" : "static", record.line);
    }
    for (const record of parsed.reexports ?? []) {
      if (record.source) follow(record.source, "reexport", record.line);
    }
    for (const dynamic of parsed.dynamicImports ?? []) {
      if (dynamic.specifier) follow(dynamic.specifier, "dynamic", dynamic.line);
      const target = dynamic.specifier ? graph.resolve(dynamic.specifier, file) : null;
      found.push({
        gap: {
          kind: "dynamic-import",
          file,
          line: dynamic.line,
          literal: Boolean(dynamic.specifier),
          resolved: target !== null && target.type !== "unresolved",
          detail: dynamic.specifier
            ? `import("${dynamic.specifier}")`
            : "import() with a computed argument",
        },
      });
    }
    found.sort((a, b) => (a.edge ?? a.gap).line - (b.edge ?? b.gap).line);
    for (const entry of found) {
      if (entry.edge) edges.push(entry.edge);
      else incomplete.push(entry.gap);
    }
  }

  const left = sorted.length - scan.length;
  if (left > 0) {
    incomplete.push({
      kind: "file-cap",
      file: null,
      line: null,
      detail: `${left} source files beyond the ${maxFiles} file limit were not read`,
    });
  }
  return { edges, incomplete, scanned: scan.length };
}

/** Edge kinds that exist when the program runs and load eagerly. */
const LOADING_KINDS = new Set(["static", "reexport"]);

/**
 * Import cycles, one closed shortest path per strongly connected component
 * (`[a, b, c, a]`), ordered by their smallest file. Type-only and dynamic
 * imports are left out: the first is erased and the second loads lazily, so
 * neither makes a load-time cycle. Iterative, so a long chain cannot overflow
 * the stack.
 *
 * @param {{ from: string, to: string, kind: string }[]} edges
 * @returns {string[][]}
 */
export function findCycles(edges) {
  const next = new Map();
  for (const { from, to, kind } of edges) {
    if (!LOADING_KINDS.has(kind)) continue;
    if (!next.has(from)) next.set(from, new Set());
    next.get(from).add(to);
    if (!next.has(to)) next.set(to, new Set());
  }
  const out = new Map([...next].map(([node, set]) => [node, [...set].sort()]));
  const nodes = [...out.keys()].sort();

  // Tarjan's strongly connected components, without recursion.
  const index = new Map();
  const low = new Map();
  const onStack = new Set();
  const stack = [];
  const components = [];
  let counter = 0;
  for (const root of nodes) {
    if (index.has(root)) continue;
    const work = [{ node: root, at: 0 }];
    index.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const targets = out.get(frame.node);
      if (frame.at < targets.length) {
        const target = targets[frame.at];
        frame.at += 1;
        if (!index.has(target)) {
          index.set(target, counter);
          low.set(target, counter);
          counter += 1;
          stack.push(target);
          onStack.add(target);
          work.push({ node: target, at: 0 });
        } else if (onStack.has(target)) {
          low.set(frame.node, Math.min(low.get(frame.node), index.get(target)));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) low.set(parent.node, Math.min(low.get(parent.node), low.get(frame.node)));
      if (low.get(frame.node) === index.get(frame.node)) {
        const component = [];
        let member;
        do {
          member = stack.pop();
          onStack.delete(member);
          component.push(member);
        } while (member !== frame.node);
        components.push(component);
      }
    }
  }

  const cycles = [];
  for (const component of components) {
    const start = component.reduce((a, b) => (a < b ? a : b));
    if (component.length === 1 && !out.get(start).includes(start)) continue;
    const members = new Set(component);
    // Breadth-first from the start back to itself: the shortest way round.
    const parent = new Map();
    let last = null;
    for (let frontier = [start]; frontier.length > 0 && last === null;) {
      const following = [];
      for (const node of frontier) {
        for (const target of out.get(node)) {
          if (!members.has(target)) continue;
          if (target === start) {
            last = node;
            break;
          }
          if (parent.has(target)) continue;
          parent.set(target, node);
          following.push(target);
        }
        if (last !== null) break;
      }
      frontier = following;
    }
    const way = [];
    for (let node = last; node !== start; node = parent.get(node)) way.push(node);
    cycles.push([start, ...way.toReversed(), start]);
  }
  return cycles.sort((a, b) => (a[0] < b[0] ? -1 : 1));
}
