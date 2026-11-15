# pi-docs-drift: which docs are older than the code they describe?

Compares each doc's last commit with the commits that touched the code it
describes. Read-only: it writes nothing and uses no model, key or network.

```
/docs-drift                  # every doc in the repository
/docs-drift packages/a docs  # only docs under these paths (repo-relative)
/docs-drift --json           # the same result as JSON
```

## What it judges

Tracked files only, so a doc has a commit to compare against:

- `README` files (`README.md`, `readme.markdown`, ...) at any depth.
- Prose files (`.md`, `.mdx`, `.markdown`, `.rst`, `.adoc`, `.txt`) under any `docs/` directory.
- `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` and `.github/copilot-instructions.md`.

## How a doc is mapped to code

A doc maps to the union of three things, and the output names which rule found each file.

1. **Paths it mentions.** Link targets and inline code spans, outside fenced blocks.
   `../src/parse.mjs`, `src/load.mjs:42` and `lib/` all count. A path is tried
   relative to the doc's directory first, then to the repository root. It must be a
   tracked file, or a directory that holds tracked files (then every file under it is
   mapped).
2. **Its own directory, for a README.** `pkg/README.md` describes `pkg/`. A README at the
   repository root does not describe the whole repository, so it maps only through the
   other two rules.
3. **Identifiers it mentions.** An inline code span such as `parseConfig`, `max_size`
   or `run()` is looked up with `git grep -w`. It maps to the files that use it, but only
   when that is five files or fewer: a name used everywhere points nowhere in
   particular. At most 20 identifiers per doc are looked up.

Prose files are never mapped as code, so a doc is not judged against its neighbours.

## The verdict

| Status | Meaning |
| --- | --- |
| `stale` | Some mapped file changed in a commit after the doc's last commit. The line lists up to five of them, newest first, each with its date and commit. |
| `current` | The doc maps to code and none of it changed after the doc's last commit. |
| `can't tell` | The doc maps to no code, or git cannot give a history to trust. The reason is on the line. A doc is never reported `current` in this case. |

`can't tell` also covers a shallow clone (the history is incomplete), a repository
with no commits, and a directory that is not a git repository. Only committed
history counts: uncommitted edits to the doc or the code are not looked at.

## Output

One tab-separated line per doc, status first, then a summary line:

```
stale	docs/guide.md	doc last changed 2026-11-01 (a1b2c3d); changed since: src/parse.mjs 2026-11-10 (e4f5a6b)
current	docs/api.md	doc last changed 2026-11-12 (c0ffee1); none of 3 mapped files changed after the doc's last commit
can't tell	README.md	no code mapped: it names no tracked file, directory or identifier
docs-drift: 1 stale, 1 current, 1 can't tell (3 docs)
```

Filter it like any text: `grep '^stale'`. With `--json`, the result is
`{ docs: [{ path, status, reason, doc, mapped, changed }], summary }`, with the same
status strings, the mapped files (and the rule behind each) and the changed files
(path, commit, ISO date).

## Limits

The mapping is a heuristic, kept simple enough to explain. A doc that describes
behaviour without naming a file or identifier is `can't tell`. A doc that names a
file it only mentions in passing can be marked stale by an unrelated change there.
A renamed file is followed only by the new name. Treat `stale` as a place to look.
