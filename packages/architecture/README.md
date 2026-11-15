# pi-architecture — do the imports respect the boundaries?

A deterministic, read-only check of a repository's import structure against rules
a person wrote, plus import cycles. TypeScript and JavaScript only. It uses no
model, no API key and no network, and it writes nothing.

```
/architecture
```

The agent can run the same check as the deferred `architecture_check` tool
(read-only, no arguments), which returns the text and a structured report.

## The rules file

`.pi/architecture.json` in the repository root. You write and own it; this package
never creates or edits it.

```json
{
  "version": 1,
  "ignore": ["**/test/**"],
  "cycles": "report",
  "rules": [
    {
      "name": "packages-are-islands",
      "from": "packages/*/**",
      "forbid": ["packages/**"],
      "except": ["packages/$1/**"],
      "reason": "share code through shared/"
    },
    { "name": "shared-is-a-leaf", "from": "shared/**", "forbid": ["packages/**"] }
  ]
}
```

- `from` selects the importing files. `forbid` lists what they must not import;
  `except` carves out what is allowed anyway. `reason` is shown with a violation.
- Patterns: `*` is any text inside one path segment, `**` crosses directories, `?`
  is one character. `$1`, `$2` stand for the text the 1st and 2nd `*` in `from`
  matched, inserted literally. So `packages/*/**` with `except: ["packages/$1/**"]`
  lets each package import itself and nothing else under `packages/`.
- `ignore` skips importing files that match (tests, usually): their edges are not
  checked and gaps inside them are not listed. `"cycles": "off"`
  turns the cycle report off.
- A typo is an error, not a rule that silently does nothing: unknown keys, a rule
  without a name or `forbid`, a duplicate name, or a `$n` that `from` cannot supply.
  A rule with an error is left out and the others still run; the errors are listed
  and the result is not "ok".

With no rules file, only the cycle check runs and the report says so.

### This repository's own rules

[`.pi/architecture.json`](../../.pi/architecture.json) here describes how pi-extensions
works today, and `test/repo-rules.test.mjs` runs the check against it, so a new
boundary break fails `npm run check`:

- `shared/` imports nothing from `packages/` or `scripts/`.
- `packages/` does not import `scripts/`.
- A package imports only itself and `shared/`. The `except` list in
  `packages-are-islands` names the 13 cross-package files that were already imported
  when the rules were written. Move one into `shared/` and delete its line; do not add
  to the list.
- Import cycles are reported, and there are none.

## What counts as an import

Static imports, `import type` (reported with its kind), re-exports, `require("...")`
and a literal `import("./x")`. A boundary rule applies to all of them. Cycles are
found among the imports that load eagerly (static, re-export, require): a type-only
import is erased and a dynamic import loads lazily, so neither makes a load-time
cycle. Each cycle is one shortest closed path, for example `a.ts -> b.ts -> a.ts`.

Resolution is `shared/import-graph.mjs`, the same module `code-search` uses:
relative paths with extension and index probing, `tsconfig`/`jsconfig` `paths`,
and workspace package names. Bare packages are external and are not part of the
graph.

## Incomplete coverage is not a pass

The report lists everything it could not follow, and says **INCOMPLETE** when the
list is not empty. A result with incomplete coverage means "no problems in what it
could see", never "clean".

| Listed as | Why |
| --- | --- |
| `dynamic-import` | Every `import()`. A literal one also becomes an edge and is checked; a computed one cannot be followed. |
| `unresolved` | A relative import with no file, or an alias that matches a `paths` entry but no file. |
| `unreadable`, `too-large`, `unparseable` | A file it could not read, over 1,000,000 characters, or could not parse. |
| `file-cap` | More than 5,000 TypeScript/JavaScript files: the first 5,000 (by path) are read. |
| `inventory-cap` | The repository listing itself hit its limit. |

Non-TypeScript/JavaScript files (JSON, CSS, Markdown, other languages) are counted
as `otherFiles` and not parsed. An import of one still resolves to an edge, but
what that file imports is not followed.

## Layout

`glob.mjs` (patterns), `rules.mjs` (parse and validate), `check.mjs` (the check and
its text) are pure and tested on in-memory repositories. The file listing comes from
`code-search`'s inventory (git, or a gitignore-aware walk). The edge list, cycle
search and `import()` detection are in `shared/import-graph.mjs` and
`code-search/ts-parser.mjs`.
