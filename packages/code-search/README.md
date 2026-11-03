# pi-code-search

Find your way around a codebase: map files, search code, and follow symbols to
their definitions. These four read-only tools are available to the agent without
extra setup after you [install the collection](../../README.md#install).

For example, ask pi:

> Find where retry delays are calculated, then show me the function and its callers.

The agent can search for the name, inspect the surrounding code, and follow an
import to the definition without reading whole files along the way.

## Tools

| Tool | Use it to |
| --- | --- |
| `repo_map(depth?)` | Get the layout of an unfamiliar repo: directories, languages, key files, package scripts, and recent or large files. |
| `code_search(query, path?, caseSensitive?, wholeWord?, regex?, maxResults?)` | Search file contents. Results show the enclosing function or class, with definitions first and comment-only matches last. |
| `file_outline(path)` | See a file's functions, classes, fields, types and imports in line order before deciding what to read. |
| `find_definition(symbol, fromFile?, kind?)` | Find where a symbol is defined. Supply `fromFile` to follow its import; omit it to list matching definitions, exported ones first. |

Search uses plain substrings by default. Set `regex`, `wholeWord`,
`caseSensitive`, or `path` to narrow it. A search with no hits can suggest
similar symbol names.

`find_definition` follows relative imports, `require`, aliases, workspace
packages and re-exports. It checks up to eight re-export links and stops cycles.
External packages are reported as `external: <pkg> — not indexed`;
`node_modules` is not scanned.

## How it works

**Files come from Git when available.** The inventory uses
`git ls-files --cached --others --exclude-standard` at the repository root:
tracked and untracked files, respecting Git's ignore rules. Without Git, a Node
file walker and built-in ignore matcher provide a fallback.

**The cache survives restarts.** `<root>/.pi/cache/pi-code-search.json` stores
paths, modification times, sizes and symbol tables. Only files whose time or size
changed are parsed again. Cache writes are atomic; a corrupt or outdated cache
is rebuilt. No background watcher is needed.

**Parsing is approximate, not a compiler.** The TypeScript/JavaScript tokenizer
handles comments, strings, templates and brace scopes. It extracts declarations,
methods, fields, types, imports and re-exports. Regex literals use a heuristic;
JSX and automatic semicolon insertion are not fully parsed. See
`ts-tokenizer.mjs` and `ts-parser.mjs` for those limits. The shared parser state
is split across `ts-scanner.mjs`, `ts-declarations.mjs` and `ts-members.mjs`.
Python, Go, Rust, Ruby, Java, Kotlin, C/C++ and Markdown use line-based heuristics;
other files get a generic `name(` fallback.

## Plan mode

All four tools are marked read-only and local, so `/plan` can use them too.
They do not edit source files; their only write is the cache.

## Notes and non-goals

- `node_modules`, `.git`, and `.pi/cache` are always excluded.
- Binary files and files over 1 MB are skipped by search but counted in the map.
- This is not semantic or embeddings search.
- Alias resolution uses the root tsconfig/jsconfig, not the nearest nested config.
- Runtime imports are Node built-ins and pi's `typebox`; no separate service is needed.
