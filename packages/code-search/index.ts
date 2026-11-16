// code-search.ts — pi extension: faster, more reliable code discovery.
//
// Registers four always-on read-only tools:
//   repo_map        — compact gitignore-aware map of the repo
//   code_search     — content search with definition-first ranking + framing
//   file_outline    — symbol outline of one file
//   find_definition — locate a symbol's definition (imports, aliases,
//                     workspaces, re-exports)
//
// Backed by a persistent cache at <root>/.pi/cache/pi-code-search.json
// (mtime-invalidated, atomic writes) holding the file inventory + per-file
// symbol tables. That cache is a derived index, so the tools are annotated
// read-only. Git-aware inventory via pi.exec; pure-node fallback walker.
// Zero runtime dependencies: node: built-ins + pi's typebox only.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { LOCAL_READ } from "../../shared/tool-annotations.mjs";
import { Type } from "typebox";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  cachePathFor,
  cacheStats,
  loadCache,
  parseFilePayload,
  refreshCache,
  saveCache,
} from "./cache.mjs";
import { findRepoRoot, listRepoFiles, normalizeRel } from "../../shared/inventory.mjs";
import { attachContext, clampContext, MAX_CONTEXT } from "./hit-context.mjs";
import { searchRepo } from "./search.mjs";
import {
  buildTreeLines,
  findKeyFiles,
  findTestFiles,
  formatDefinitions,
  formatOutline,
  formatRepoMap,
  formatSearchHits,
  languageBreakdown,
  packageHighlights,
} from "./format.mjs";
import { loadImportGraph } from "../../shared/import-graph.mjs";
import { resolveDefinition } from "./resolve.mjs";

interface CacheEntry {
  mtimeMs: number;
  size: number;
  lang: string;
  symbolCount?: number;
  symbolsTruncated?: boolean;
  symbolsDropped?: boolean;
  symbols: Array<{
    name: string;
    kind: string;
    signature?: string;
    startLine: number;
    endLine: number;
    exported?: boolean;
    col?: number;
  }>;
  imports?: Array<{
    names: Array<{ imported: string; local: string }>;
    source: string;
    typeOnly?: boolean;
    line?: number;
  }>;
  reexports?: Array<{
    names: Array<{ imported: string; local: string }> | null;
    source: string | null;
    line?: number;
  }>;
}

interface SessionState {
  root: string;
  viaGit: boolean;
  cache: {
    version: number;
    root: string;
    builtAt: number;
    files: Record<string, CacheEntry>;
  } | null;
  cachePath: string;
  built: boolean;
  /** The inventory hit its file cap, so the map is partial. */
  truncated: boolean;
  symbolCount: number;
}

type ExecFn = (
  cmd: string,
  args: string[],
  opts?: { timeout?: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

function makeExec(pi: ExtensionAPI): ExecFn {
  return async (cmd, args, opts) => {
    const r = await pi.exec(cmd, args, { timeout: opts?.timeout ?? 10_000 });
    return { code: r.code, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
  };
}

interface UiLite {
  hasUI?: boolean;
  cwd?: string;
  ui?: { notify?: (title: string, level?: string) => void };
}

function notify(ctx: UiLite, message: string) {
  if (ctx.hasUI) ctx.ui?.notify?.(message, "info");
}

export default function piCodeSearchExtension(pi: ExtensionAPI) {
  const exec = makeExec(pi);
  // One in-flight refresh per repo root; sibling tool calls share it.
  const inflight = new Map<string, Promise<SessionState>>();

  async function getSession(
    root: string,
    viaGit: boolean,
    ctx: UiLite,
    onUpdate?: (update: { content: Array<{ type: string; text: string }> }) => void,
  ): Promise<SessionState> {
    const existing = inflight.get(root);
    if (existing) return existing;
    const p = buildSession(root, viaGit, ctx, onUpdate).finally(() => inflight.delete(root));
    inflight.set(root, p);
    return p;
  }

  async function buildSession(
    root: string,
    viaGit: boolean,
    ctx: UiLite,
    onUpdate?: (update: { content: Array<{ type: string; text: string }> }) => void,
  ): Promise<SessionState> {
    const cachePath = cachePathFor(root);
    const previous = await loadCache(cachePath);
    const {
      cache: next,
      changed,
      truncated,
    } = await refreshCache({
      cache: previous,
      root,
      list: () => listRepoFiles({ root, exec }),
      stat: async (rel) => {
        try {
          const s = await stat(join(root, rel));
          return { mtimeMs: s.mtimeMs, size: s.size };
        } catch {
          return null;
        }
      },
      readFile: async (rel) => {
        try {
          return await readFile(join(root, rel), "utf8");
        } catch {
          return null;
        }
      },
      onProgress: (done, total) => {
        onUpdate?.({ content: [{ type: "text", text: `Indexing… ${done}/${total} files` }] });
      },
    });
    const dirty = previous == null || changed.length > 0 || truncated;
    if (dirty) {
      try {
        await saveCache(cachePath, next);
      } catch {
        // Cache write failure is non-fatal: tools still work in-memory.
      }
    }
    const stats = cacheStats(next);
    return {
      root,
      viaGit,
      cache: next,
      cachePath,
      built: changed.length > 0,
      truncated,
      symbolCount: stats.symbolCount,
    };
  }

  async function sessionFor(
    ctx: UiLite,
    onUpdate?: (update: { content: Array<{ type: string; text: string }> }) => void,
  ): Promise<SessionState> {
    const cwd = ctx.cwd ?? process.cwd();
    // The root and whether it came from git are needed here anyway; passing
    // both down saves buildSession a second `git rev-parse`.
    const { root, viaGit } = await findRepoRoot(cwd, exec);
    const session = await getSession(root, viaGit, ctx, onUpdate);
    if (session.built) {
      session.built = false; // only the first caller reports the build
      notify(
        ctx,
        `Indexed ${Object.keys(session.cache?.files ?? {}).length} files — ${session.symbolCount} symbols`,
      );
    }
    return session;
  }

  /** Validate a user-supplied repo-relative path; returns rel or an error string. */
  function validateRel(input: unknown): { ok: true; rel: string } | { ok: false; error: string } {
    let raw = String(input ?? "")
      .replace(/^@/, "")
      .replace(/\\/g, "/")
      .trim();
    if (!raw) return { ok: false, error: "path is empty" };
    if (raw.startsWith("/"))
      return { ok: false, error: `absolute paths are not allowed: "${raw}"` };
    if (raw.split("/").includes("..")) return { ok: false, error: `".." is not allowed in paths` };
    const rel = normalizeRel(raw);
    if (!rel) return { ok: false, error: "path resolves to empty" };
    return { ok: true, rel };
  }

  async function readRootJson(root: string, names: string[]): Promise<unknown | null> {
    for (const name of names) {
      try {
        return JSON.parse(await readFile(join(root, name), "utf8"));
      } catch {
        // try next
      }
    }
    return null;
  }

  function loadGraph(root: string, files: Record<string, CacheEntry>) {
    return loadImportGraph({
      files: Object.keys(files),
      readFile: async (rel: string) => {
        try {
          return await readFile(join(root, rel), "utf8");
        } catch {
          return null;
        }
      },
    });
  }

  // --- repo_map -------------------------------------------------------------

  pi.registerTool({
    name: "repo_map",
    label: "repo_map",
    annotations: LOCAL_READ,
    description:
      "Compact gitignore-aware map of the repository: header (root, branch, file count, size, languages), " +
      "a collapsed tree, key files (README, manifests, CI, test files), package.json highlights, and the " +
      "newest and largest files. Call this first on unfamiliar repos to build the layout before searching.",
    promptSnippet:
      "repo_map(depth?): compact gitignore-aware map of the repo — tree, key files, package scripts, languages, biggest/newest files; call first on unfamiliar repos",
    promptGuidelines: [
      "Use repo_map first on unfamiliar repos: one call gives the layout, languages, manifests, and package scripts before any search or read.",
    ],
    parameters: Type.Object({
      depth: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 4, description: "Tree depth (default 2)." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const session = await sessionFor(ctx, onUpdate);
      const files = session.cache?.files ?? {};
      const rels = Object.keys(files);
      const tree = buildTreeLines(rels, Number(params?.depth) || 2);
      const languages = languageBreakdown(rels);
      const keyFiles = findKeyFiles(rels);
      const testFiles = findTestFiles(rels);
      let pkg: string[] | null = null;
      if (files["package.json"]) {
        const json = await readRootJson(session.root, ["package.json"]);
        pkg = packageHighlights("package.json", json);
      }
      const entries = Object.entries(files).map(([rel, e]) => ({ rel, ...e }));
      const newest = [...entries].sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, 10);
      const largest = [...entries].sort((a, b) => b.size - a.size).slice(0, 10);
      let branch = "";
      if (session.viaGit) {
        try {
          const r = await exec("git", ["-C", session.root, "rev-parse", "--abbrev-ref", "HEAD"], {
            timeout: 3000,
          });
          if (r.code === 0) branch = r.stdout.trim();
        } catch {
          branch = "";
        }
      }
      const text = formatRepoMap({
        root: session.root,
        branch,
        viaGit: session.viaGit,
        files: entries,
        truncated: session.truncated,
        languages,
        tree,
        keyFiles,
        testFiles,
        pkg,
        newest,
        largest,
        symbolCount: session.symbolCount,
      });
      return { content: [{ type: "text", text }] };
    },
  });

  // --- code_search ----------------------------------------------------------

  pi.registerTool({
    name: "code_search",
    label: "code_search",
    annotations: LOCAL_READ,
    description:
      "Search repository file contents. Plain substring by default (case-insensitive); set regex=true for " +
      "regular expressions, wholeWord=true for word boundaries, caseSensitive=true for exact case, path=dir to " +
      "scope to a subtree. Results are ranked definition-first and framed with the enclosing function/class " +
      "when the cache has symbols. A page shows at most 5 matches per file; when more remain the result ends " +
      "with a cursor, and passing it back (same query and options) returns the next hits. " +
      "Set context=N (0-10) to get N numbered lines around each hit, in the file's exact text: enough to " +
      "edit from without a separate read. A hit whose exact line repeats in its file says so, because such " +
      "a line cannot anchor an edit alone. Independent queries can go in one turn as parallel calls; each " +
      "result is labelled with its query and options. " +
      "Prefer this over grep when you need ranked, contextual results.",
    promptSnippet:
      "code_search(query, path?, caseSensitive?, wholeWord?, regex?, maxResults?, context?, cursor?): content search with definition-first ranking and enclosing function/class framing; context=N adds the lines around each hit; pass the returned cursor to page on; prefer over grep when you need context or ranked results",
    promptGuidelines: [
      "Use code_search for content queries when ranking or context matters: definitions rank first and each hit is framed with its enclosing function/class. Narrow with path=<dir> when results are broad.",
      "When you are about to edit what you search for, pass context=N (2 to 5 is usually enough) so the hit already shows the lines you will replace, and skip the separate read. If a hit says its line repeats in the file, include a neighbouring line in the edit.",
      "Run independent code_search calls together in one turn rather than one after another.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Text to find (plain substring unless regex=true)." }),
      path: Type.Optional(
        Type.String({ description: "Scope to a repo-relative directory or file." }),
      ),
      caseSensitive: Type.Optional(
        Type.Boolean({ description: "Match case exactly (default false)." }),
      ),
      wholeWord: Type.Optional(
        Type.Boolean({ description: "Require word boundaries (default false)." }),
      ),
      regex: Type.Optional(
        Type.Boolean({ description: "Treat query as a regular expression (default false)." }),
      ),
      maxResults: Type.Optional(
        Type.Integer({ minimum: 1, maximum: 100, description: "Max hits to return (default 30)." }),
      ),
      context: Type.Optional(
        Type.Integer({
          minimum: 0,
          maximum: MAX_CONTEXT,
          description:
            "Lines to show above and below each hit (default 0). Use it when you will edit the match, to skip a separate read. Does not change which hits match or the cursor.",
        }),
      ),
      cursor: Type.Optional(
        Type.String({
          description:
            "Continuation cursor from a previous result with the same query and options. Returns the next hits.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const session = await sessionFor(ctx, onUpdate);
      const query = String(params?.query ?? "").trim();
      if (!query) return { content: [{ type: "text", text: "Rejected: query is empty." }] };
      let scope: string | null = null;
      if (params?.path !== undefined && params?.path !== "") {
        const v = validateRel(params.path);
        if (!v.ok) return { content: [{ type: "text", text: `Rejected: ${v.error}` }] };
        scope = v.rel;
      }
      try {
        const readSource = async (rel: string) => {
          try {
            return await readFile(join(session.root, rel), "utf8");
          } catch {
            return null;
          }
        };
        const found = await searchRepo({
          cache: session.cache,
          query,
          opts: {
            path: scope ?? undefined,
            caseSensitive: params?.caseSensitive === true,
            wholeWord: params?.wholeWord === true,
            regex: params?.regex === true,
            maxResults: params?.maxResults,
            cursor: params?.cursor || undefined,
          },
          readFile: readSource,
          exec,
          root: session.root,
          viaGit: session.viaGit,
          signal,
        });
        const context = clampContext(params?.context);
        const { hits, omitted } = await attachContext({
          hits: found.hits,
          context,
          readFile: readSource,
        });
        return {
          content: [
            {
              type: "text",
              text: formatSearchHits({
                query,
                hits,
                total: found.total,
                start: found.start,
                remaining: found.remaining,
                truncated: found.truncated,
                nextCursor: found.nextCursor,
                suggestion: found.suggestion,
                options: {
                  path: scope,
                  caseSensitive: params?.caseSensitive === true,
                  wholeWord: params?.wholeWord === true,
                  regex: params?.regex === true,
                  context,
                },
                contextOmitted: omitted,
              }),
            },
          ],
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `code_search failed: ${msg}` }] };
      }
    },
  });

  // --- file_outline ---------------------------------------------------------

  pi.registerTool({
    name: "file_outline",
    label: "file_outline",
    annotations: LOCAL_READ,
    description:
      "Symbol outline of one file: functions, classes, methods, fields, interfaces, types, imports, and " +
      "their line numbers, sorted by line. Call this before reading a file fully to decide what to read.",
    promptSnippet:
      "file_outline(path): symbol outline of one file (functions, classes, methods, imports) — call before reading a file fully",
    promptGuidelines: [
      "Use file_outline to inspect a file's structure (symbols + line numbers) before committing to a full read.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Repo-relative path to the file." }),
    }),
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const session = await sessionFor(ctx, onUpdate);
      const v = validateRel(params?.path);
      if (!v.ok) return { content: [{ type: "text", text: `Rejected: ${v.error}` }] };
      const entry = session.cache?.files?.[v.rel];
      let symbols = entry?.symbols ?? [];
      let truncated = entry?.symbolsTruncated === true;
      if (!entry || entry.symbolsDropped) {
        try {
          const text = await readFile(join(session.root, v.rel), "utf8");
          const payload = parseFilePayload(text, v.rel);
          symbols = payload.symbols.list;
          truncated = payload.symbols.truncated;
        } catch {
          return {
            content: [
              { type: "text", text: `file_outline: "${v.rel}" not found in the repo inventory.` },
            ],
          };
        }
      }
      return {
        content: [{ type: "text", text: formatOutline({ relPath: v.rel, symbols, truncated }) }],
      };
    },
  });

  // --- find_definition ------------------------------------------------------

  pi.registerTool({
    name: "find_definition",
    label: "find_definition",
    annotations: LOCAL_READ,
    description:
      "Locate the definition of a symbol. When fromFile is given, the symbol's import/require/reexport in that " +
      "file is resolved (relative specifiers with extension/index probing, tsconfig/jsconfig path aliases, " +
      "workspace package names, re-export chains). Without fromFile, all definition candidates across the repo " +
      "are listed (exported first). External package symbols are reported as 'external — not indexed' " +
      "(node_modules is never scanned).",
    promptSnippet:
      "find_definition(symbol, fromFile?, kind?): locate the definition of a symbol, resolving relative imports, tsconfig/jsconfig path aliases, workspace packages, and re-exports",
    promptGuidelines: [
      "Use find_definition when asked 'where is X defined' or when an import is aliased/renamed and you need the real defining file.",
    ],
    parameters: Type.Object({
      symbol: Type.String({ description: "Symbol name to find." }),
      fromFile: Type.Optional(
        Type.String({ description: "Repo-relative file to resolve the symbol's import from." }),
      ),
      kind: Type.Optional(
        Type.String({
          description:
            "Optional kind filter: function, class, interface, type, enum, const, method, field.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, onUpdate, ctx) {
      const session = await sessionFor(ctx, onUpdate);
      const symbol = String(params?.symbol ?? "").trim();
      if (!symbol) return { content: [{ type: "text", text: "Rejected: symbol is empty." }] };
      let fromFile: string | undefined;
      if (params?.fromFile !== undefined && params?.fromFile !== "") {
        const v = validateRel(params.fromFile);
        if (!v.ok) return { content: [{ type: "text", text: `Rejected: ${v.error}` }] };
        fromFile = v.rel;
      }
      const kind = typeof params?.kind === "string" && params.kind ? params.kind : undefined;
      const graph = await loadGraph(session.root, session.cache?.files ?? {});
      const result = await resolveDefinition({
        symbol,
        fromFile,
        kind,
        cache: session.cache,
        graph,
        readFile: async (rel) => {
          try {
            return await readFile(join(session.root, rel), "utf8");
          } catch {
            return null;
          }
        },
      });
      return {
        content: [
          {
            type: "text",
            text: formatDefinitions({
              symbol,
              external: result.external,
              candidates: result.candidates,
              note: result.note,
            }),
          },
        ],
      };
    },
  });
}
