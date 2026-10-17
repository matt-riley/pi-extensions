# pi-done-gate — no "done" on faith

When a run ends with code edits made after the last verification run, this
gives the model one more turn. The reminder is `display: false`: the model
reads it, the transcript does not, and it asks for the closing message to carry
the explanation of the work rather than a report about the reminder.

This is the text the model sees (you don't):

```
Done check: 2 file(s) changed after the last verification run (src/a.ts, src/b.ts).
Before reporting done, run the repo's checks (`.pi/verify` if present) and exercise
the changed behavior, or say plainly why verification does not apply. Then close
with your explanation of the work plus one line of what the check proved, not a
report about this reminder.
Leftover debug instrumentation to remove: src/a.ts:42.
TypeSafe reads that claim as done with the unverified edits unmentioned
(asserts_verified 0.88 · acknowledges_gap 0.05). Name what is unverified, or run the checks.
```

No tools, no config, no runtime dependencies. The last line appears only when a
claim judgment disagrees with what the run actually did; without TypeSafe
credentials the reminder stops after the first paragraph.

## What arms the gate

The nudge asks for the repo's checks, so it only fires where those checks could
apply.

- **Inside the session cwd.** A write to `/tmp`, a home dotfile, or another
  repository never arms it. In a sample of 32 real nudges, 15 flagged only such
  paths, and each cost a turn spent explaining that verification does not apply.
- **Still in the working tree.** At settle, the dirty paths are intersected
  with `git diff --name-only --relative HEAD` plus untracked files. An edit
  reverted during the run, already merged, or written to an ignored/generated
  path is not a finding. If git cannot answer (no repo, no HEAD, git missing)
  the gate keeps its paths rather than going silent.
- **Non-doc, successful, after the last verification.** Prose edits, failed
  edits, and edits followed by a check do not arm it.

## Why `agent_before_settle`

A `tool_result` patch (how `pi-diagnosis-nudge` works) lands mid-run, before
the model has decided it is finished. `agent_before_settle` is the last boundary
that can still act: the handler appends a `custom_message` entry and returns
`continue: true` for exactly one more model request, so the reminder is read
before the turn closes instead of after the user has already seen "done".

`display: false` keeps that message out of the terminal. Per
`message-types.md`, `display` controls rendering only — pi still converts the
entry to a user message for the next request — so the enforcement is unchanged
and the transcript keeps the explanation and the checks, not a meta block.

It never blocks a tool call. The model may answer the nudge by running the
checks or by saying why they do not apply.

## The claim judgment

The reminder cannot read the claim it is answering. When the gate fires and the
run has a final assistant message, that message goes to TypeSafe's System One
(`jev-latest` unless `TYPESAFE_MODEL` says otherwise) as two typed questions:

- **asserts_verified** — does the message claim the changed code was verified,
  or only describe what changed?
- **acknowledges_gap** — does it say plainly what was left unverified?

A claim that asserts success without naming the gap gains one sentence:

```
TypeSafe reads that claim as done with the unverified edits unmentioned
(asserts_verified 0.88 · acknowledges_gap 0.05). Name what is unverified, or run the checks.
```

A claim that names its gap gets nothing added: the reminder already asked for
exactly that, and repeating it would only teach the model to skip the nudge. So
do runs with no prose claim, no credentials, a failed request, or an unusable
answer. The judgment is one extra sentence or silence — never a block, never an
error in the settle path. Thresholds and routing live in `claim.mjs`, not in a
prompt, and `judgeDoneClaim` takes an injectable `ask` so the tests never touch
the network.

## Behaviour

- **Edits** are successful `edit` / `write` calls to non-doc files inside the
  session cwd. Prose files (`.md`, `.mdx`, `.txt`, `.rst`, `.adoc`) do not
  count, and anything outside the cwd is not the repo's to check.
- **Verification** is a `bash` call that runs, in command position: `.pi/verify`,
  `npm|pnpm|yarn|bun [run] test|check|lint|typecheck|verify`, `node --test`,
  `go test|vet`, `cargo test|check|clippy`, `make test|check|lint|verify`, or
  `pytest`, `vitest`, `jest`, `tsc`, `mypy`, `ruff`, `oxlint`, `eslint`,
  `golangci-lint` (optionally via `npx`, `bunx`, `uv run`, `python -m`, …). A
  failing check still counts: the model has seen the result. `grep "npm test"`
  does not.
- **One nudge per user input**, and only after a `completed` run, never after an
  abort or error. It is appended with `display: false`.
- **One claim judgment** rides along with that nudge, when the run has a final
  assistant message to read. It is a single request with a 4-second timeout, and
  credentials resolve exactly as they do for the guardrail
  (`shared/systemone.mjs`). Every failure degrades to no extra line.
- **Debug tags.** At nudge time, added lines in `git diff -U0 HEAD` and untracked
  files (up to 200, 1 MB each) are scanned for `[DEBUG-` and listed as
  `path:line`. Tags already committed are not reported. Outside a git repo the
  scan is silently empty.
- It only ever sets `continue` to `true`, and keeps earlier handlers' entries,
  so it composes with other `agent_before_settle` extensions.

## Tests

`node --test packages/done-gate/test/*.test.mjs` — command recognition
(positive and negative), the dirty/verify state machine, cwd scoping and
working-tree liveness, outcome gating, debug-tag line numbers against a real
temporary git repo, and the claim judgment: the question set, state shaping,
threshold routing, the line it renders, and the no-request and failed-request
paths.
