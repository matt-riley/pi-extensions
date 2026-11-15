# pi-agents: create or improve an `AGENTS.md`

`/agents [dir]` makes sure the chosen directory has an `AGENTS.md`, the context
file pi loads for work in that directory and below. With no argument it uses the
session's working directory.

```
/agents              # here
/agents packages/api # a named directory
```

The argument is one path, so spaces need no shell quoting. A relative path
resolves against the session's working directory.

## What it writes

A new file gets a title, one sentence saying it applies to this directory and below, and a
`## Commands` section listing that directory's `package.json` scripts as
`npm run <name>`.

An existing file is never rewritten. If it has no Commands heading, that section
is appended after the existing text, separated by one blank line; every other
byte stays where it was. If it already has a Commands heading (any level, any
capitalisation), or there are no scripts to add, the file is left alone and the
command says so. Running it twice changes nothing the second time.

Matching is case-insensitive, so a file named `AGENTS.MD` is updated in place
rather than joined by a second, differently cased copy. A symlinked `AGENTS.md`
stays a symlink: the file it points at is updated. Writes go to a temporary file
beside the target and are renamed into place, so an interrupted write cannot
leave a half-written `AGENTS.md`.

It writes no project rules of its own, calls no model and uses no network. What
it adds comes from `package.json`; the guidance only you know (style, release
steps, gotchas) still has to be written.

## Failures

Nothing is written and the command reports an error when the path is missing or
is not a directory, the existing `AGENTS.md` cannot be read, or the write fails
(permissions, disk, a read-only checkout). If the directory has an
`AGENTS.override.md` and no `AGENTS.md`, it says so instead of creating a file
the override would shadow.

## Limits

- Scripts come from the chosen directory's own `package.json`, not a parent's.
- Only `AGENTS.md` is created. `CLAUDE.md` and other context files are not
  touched or combined.
- The generated Commands section lists every script, including lifecycle hooks.
  Edit it like any other prose; the extension never rewrites an existing section.
