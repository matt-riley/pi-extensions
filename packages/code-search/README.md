# pi-code-search

Find your way around a codebase: map files, search code, and follow symbols to
their definitions. These four read-only tools are available to the agent without
extra setup after you [install the collection](../../README.md#install).

For example, ask pi:

> Find where retry delays are calculated, then show me the function and its callers.

The agent can search for the name, inspect the surrounding code, and follow an
import to the definition without reading whole files.

## Tools

| Tool | Use it to |
| --- | --- |
| `repo_map(depth?)` | Get the layout of an unfamiliar repo: directories, languages, key files, package scripts, and recent or large files. |
| `code_search(query, path?, caseSensitive?, wholeWord?, regex?, maxResults?, context?, cursor?)` | Search file contents. Results show the enclosing function or class, with definitions first and comment-only matches last. `context` adds the lines around each hit. |
| `file_outline(path)` | See a file's functions, classes, fields, types and imports in line order before deciding what to read. |
| `find_definition(symbol, fromFile?, kind?)` | Find where a symbol is defined. Supply `fromFile` to follow its import; omit it to list matching definitions, exported ones first. |

Search uses plain substrings by default. Set `regex`, `wholeWord`,
`caseSensitive`, or `path` to narrow it. A search with no hits can suggest
similar symbol names.

A page shows at most five matches per file. A file's matches are ranked before
any are cut, so a definition late in a file still leads. When more remain, the
result ends with a `cursor`; pass it back with the same `query` and options to
get the next hits. Later pages reach both further files and further matches in
the same file, and every match appears once. A cursor is tied to the workspace,
query and filter options (`path`, `regex`, `wholeWord`, `caseSensitive`) and to
the matched files' content, so a changed search or a changed file gets a clear
error instead of silently skipped or repeated hits. `maxResults` may change
between pages. Each call re-runs the same bounded search; nothing is stored
between calls.

## Searching to edit

An edit needs the exact text of the lines it replaces. Set `context` to a number
from 0 to 10 and each hit comes with that many numbered lines above and below it,
the match marked with `>`, in the file's own text (indentation kept; a line over
200 characters is cut with `…`):

```text
src/retry.mjs:3:10
  in function retryDelay(attempt) (lines 1–4)
      2 |   const base = 100;
    > 3 |   return base * 2 ** attempt;
      4 | }
```

The agent can edit from that without a separate read. The tool text tells it to
pass `context` when it means to edit what it searches for.

- `context` defaults to 0, which gives the compact one-line hits as before. It
  does not change which hits match, their order or the cursor, so it can differ
  between pages.
- Only the hits on the page are read, each file once. A page spends at most 400
  context lines; hits past that stay plain and the result says how many.
- When a hit's exact line appears more than once in its file, the hit says so.
  Such a line cannot anchor an edit alone, so the edit should include a
  neighbouring line. The count covers lines that match the query, which is every
  repeat of a matching line.

For several questions at once, the agent can issue independent `code_search`
calls in the same turn. They share one index refresh, and each result's header
names its query and options (`[path=src/api, regex, context=3]`), so results that
differ only by path or flags stay apart.

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
