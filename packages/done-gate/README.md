# pi-done-gate — no "done" on faith

When a run ends with code edits made after the last verification run, this
appends one message and gives the model one more turn to act on it:

```
Done check: 2 file(s) changed after the last verification run (src/a.ts, src/b.ts).
Before reporting done, run the repo's checks (`.pi/verify` if present) and exercise
the changed behavior, or say plainly why verification does not apply.
Leftover debug instrumentation to remove: src/a.ts:42.
```

No tools, no config, no dependencies.

## Why `agent_before_settle`

A `tool_result` patch (how `pi-diagnosis-nudge` works) lands mid-run, before
the model has decided it is finished. `agent_before_settle` is the last boundary
that can still act: the handler appends a `custom_message` entry and returns
`continue: true` for exactly one more model request, so the reminder is read
before the turn closes instead of after the user has already seen "done".

It never blocks a tool call. The model may answer the nudge by running the
checks or by saying why they do not apply.

## Behaviour

- **Edits** are successful `edit` / `write` calls. Prose files (`.md`, `.mdx`,
  `.txt`, `.rst`, `.adoc`) do not count.
- **Verification** is a `bash` call that runs, in command position: `.pi/verify`,
  `npm|pnpm|yarn|bun [run] test|check|lint|typecheck|verify`, `node --test`,
  `go test|vet`, `cargo test|check|clippy`, `make test|check|lint|verify`, or
  `pytest`, `vitest`, `jest`, `tsc`, `mypy`, `ruff`, `oxlint`, `eslint`,
  `golangci-lint` (optionally via `npx`, `bunx`, `uv run`, `python -m`, …). A
  failing check still counts: the model has seen the result. `grep "npm test"`
  does not.
- **One nudge per user input**, and only after a `completed` run, never after an
  abort or error.
- **Debug tags.** At nudge time, added lines in `git diff -U0 HEAD` and untracked
  files (up to 200, 1 MB each) are scanned for `[DEBUG-` and listed as
  `path:line`. Tags already committed are not reported. Outside a git repo the
  scan is silently empty.
- It only ever sets `continue` to `true`, and keeps earlier handlers' entries,
  so it composes with other `agent_before_settle` extensions.

## Tests

`node --test packages/done-gate/test/gate.test.mjs` — command recognition
(positive and negative), the dirty/verify state machine, outcome gating, and
debug-tag line numbers against a real temporary git repo.
