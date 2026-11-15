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
