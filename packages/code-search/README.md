# pi-code-search

Faster, more reliable code discovery for pi. Four always-on read-only tools
that make finding code quicker (fewer round trips, cached inventory), easier
(symbol-aware queries instead of regex guessing), and more reliable
(gitignore-exact inventory, definition-first ranking, import/alias/re-export
resolution).

Zero runtime dependencies: node built-ins + pi's `typebox` only.

## Tools

| Tool | What it does |
| --- | --- |
| `repo_map(depth?)` | Compact gitignore-aware map of the repo in one call: header (root, branch, file count, size, languages), collapsed tree, key files (README, manifests, CI, test files), package.json highlights (scripts, entry, deps), and the newest + largest files. Call first on unfamiliar repos. |
| `code_search(query, path?, caseSensitive?, wholeWord?, regex?, maxResults?)` | Content search with definition-first ranking and enclosing-function/class framing. Plain substring by default; `regex`, `wholeWord`, `caseSensitive`, and `path` scoping options. Comment-only matches rank last; zero hits suggest near symbol names. |
| `file_outline(path)` | Symbol outline of one file sorted by line: functions, classes, methods, fields, interfaces, types, imports. Call before committing to a full read. |
| `find_definition(symbol, fromFile?, kind?)` | Locate the definition of a symbol. With `fromFile`, the symbol's import/require/reexport is resolved (relative specifiers with extension/index probing, tsconfig/jsconfig `paths` aliases, workspace package names, re-export chains up to depth 8 with cycle guard). Without it, all definition candidates across the repo are listed, exported first. External packages are reported as `external: <pkg> — not indexed` (node_modules is never scanned). |

## How it works

- **Git-aware inventory**: the repo root is `git rev-parse --show-toplevel`;
  files come from `git ls-files --cached --others --exclude-standard`
  (tracked + untracked, gitignore-exact). Falls back to a pure-node walker
  with a hand-rolled gitignore matcher when git is unavailable.
- **Persistent cache** at `<root>/.pi/cache/pi-code-search.json`: the file
  inventory (paths, mtimes, sizes) plus per-file symbol tables. Survives
  restarts; invalidated by mtime+size so only changed files are re-parsed;
  written atomically; corrupt/version-mismatched files rebuild cleanly.
- **TS/JS parser**: a pragmatic single-pass tokenizer (comments, strings,
  template literals with nested interpolation, heuristic regex literals) with
  brace-scope tracking. Extracts functions, classes, methods, getters/setters,
  private fields, interfaces, type aliases, enums, const/let/var (incl.
  arrows and destructuring), imports, and re-exports. Known approximations are
  documented in `ts-parser.mjs` (regex-literal heuristic, JSX as token soup,
  ASI ignored).
- **Other languages**: line-based heuristics for Python, Go, Rust, Ruby, Java,
  Kotlin, C/C++, and Markdown; a generic fallback catches `name(` patterns.
- **Exclusions**: `node_modules`, `.git`, and `.pi/cache` are always excluded;
  binary extensions and >1MB files are skipped by search but counted by the
  map.

## Plan mode

`repo_map`, `code_search`, `file_outline`, and `find_definition` are added to
plan mode's `PLAN_TOOLS` allowlist, so `/plan` gets the same discovery power
(read-only tools, no bash changes).

## Notes and non-goals

- No semantic/embeddings search, no node_modules indexing, no nearest-tsconfig
  resolution (root tsconfig/jsconfig only), no background watcher — the cache
  builds lazily on first use.
- The four tools never mutate files; the only write is the cache itself.
