# pi-affected: which tests can this change reach?

Test selection from the import graph. Read-only: it **runs no tests**, writes
nothing, and uses no model, key or network. TypeScript and JavaScript only.

```
/affected              # your working-tree changes
/affected origin/main  # plus everything this branch changed since it forked
```

The agent gets the same through the deferred `affected_tests` tool (`base?`, or an
explicit `files` list to skip git), returned as text and as structured data.

## How it picks

Changed files are the tracked edits against `HEAD`, untracked files, and, with a
base ref, `git diff base...HEAD`. From each, it walks the import graph backwards
(`shared/import-graph.mjs`, the module `code-search` and `architecture` share) and
collects the test files it reaches: `*.test.*`, `*.spec.*`, or anything in
`__tests__/`, in JS or TS. A changed test file selects itself. Every kind of edge
counts, including type-only imports and literal `import("./x")`, so it errs toward
selecting more.

When the runner is recognisable from the root `scripts.test` (`node --test`, vitest
or jest), the text ends with a command line for the selection. It is a suggestion;
nothing is executed.

## Gaps

| Gap | Meaning |
| --- | --- |
| No test reaches a changed file | A TS/JS file nothing a test imports depends on. |
| Not TypeScript or JavaScript | A changed JSON, CSS, Markdown or config file that no test imports. Tests that read it at runtime are not found. |
| Deleted | A deleted file cannot be traced; importers of it show as unresolved. |

## Fallback to the package-level command

If the graph cannot be trusted, any test might reach any change, so selecting is
guessing. The result is then `mode: "fallback"`: it names the package-level test
command (`npm test`, or `npm test --workspace <dir>` for the nearest package with a
`scripts.test`) to run instead, says why, and still lists the tests it did find as a
floor ("at least N"). The graph is incomplete when, somewhere a test can reach, there
is a computed `import()`, an `import()` or relative import that names no file, an
alias that matches a `paths` entry but no file, an unreadable, oversized or
unparseable file, or when a file cap or the inventory cap was hit. Gaps in code no
test can reach are counted but do not trigger it. More than 500 changed files also
falls back.

With changes but no mode `fallback`, `complete` is true only when there are no gaps
at all. `mode: "nothing"` means no changed files.

`affected.mjs` (selection, text) and `changed.mjs` (git, with the base ref checked so
it cannot be an option or a shell word) are pure or take an injected `exec`, and are
tested on in-memory repositories and a fake git.
