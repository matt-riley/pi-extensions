# pi-done-gate — no "done" on faith

When a run ends with code edits made after the last verification run, this
gives the model one more turn. The reminder is `display: false`: the model
reads it, the transcript does not, and it asks for the closing message to carry
the explanation of the work rather than a report about the reminder.

This is the text the model sees (you don't):

```
Done check: 1 file(s) changed after the last verification run (pkg/foo/a.go).
Before reporting done, run `go test ./pkg/foo` and `golangci-lint run ./pkg/foo`
as separate commands, and exercise the changed behavior, or say plainly why
verification does not apply. Then close with your explanation of the work plus
one line of what the check proved, not a report about this reminder.
```

When nothing in the change maps to a command, or the only signal is a closing
claim, the middle sentence stays the generic one: run the repo's checks
(`.pi/verify` if present). The TypeSafe sentence is unchanged, and it appears
only when a claim judgment disagrees with what the run actually did. Without
credentials the reminder stops after the commands.

No config or runtime dependencies.

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
  edits, and edits followed by a successful final-revision check do not arm it.
  Failed, unknown, skipped/masked or stale checks leave code unverified.

## Which commands

The reminder names the commands that cover the files still dirty at settle.
A successful run of one of those commands, as its own bash call, after the
last edit is a verification run, so the gate does not fire again. Run them
separately: `go test ./pkg/foo && golangci-lint run ./pkg/foo` is still one
compound shell, and those do not count.

**`.pi/verify` wins.** If that path exists (a file or a directory), it is the
only command named. The language mapping is not also listed.

Otherwise the mapping is deterministic and needs no TypeSafe key:

- **Go.** A `.go` file belongs to its directory. `pkg/foo/testdata` belongs to
  `./pkg/foo`, because the Go tool ignores `testdata`. One package is
  `go test ./pkg/foo`. Several packages under one directory collapse to
  `go test ./pkg/...`. Packages that only meet at the repo root are listed
  (`go test ./cmd/tool ./pkg/foo`), never `go test ./...`. A nested `go.mod`
  is `go test -C <module> <packages>`, still one command.
  `golangci-lint run` is added on those same packages when a
  `.golangci.yml`, `.golangci.yaml`, `.golangci.toml` or `.golangci.json`
  sits on the way up from a changed file, or when `golangci-lint` is on `PATH`.
- **TypeScript** (`.ts`, `.tsx`, `.mts`, `.cts`). `tsc --noEmit -p` the nearest
  `tsconfig*.json`. Files that share a config share one command. A plain
  `tsconfig.json` wins when that directory also has other configs. A file with
  no tsconfig is not given a `tsc` command.
- **Lua.** `stylua --check <files>` when `stylua.toml` or `.stylua.toml` is
  above the file, and `selene <files>` when `selene.toml` is. Both, when both
  configs exist. Files with neither config are left off the command.

Jev is asked only when the nearest directory has two or more tsconfigs and
none of them is `tsconfig.json` (app versus node, for example). With a key it
picks one command. With no key, a failed request, or an unusable answer, every
candidate stays in the reminder. Clear mappings never call it.

A change that matches none of this — a Python file, a `go.mod`, a TypeScript
file with no tsconfig — keeps the generic sentence.

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
(`jev-1.13.0` unless `TYPESAFE_MODEL` says otherwise) as three typed questions:

- **asserts_verified** — does the message claim the changed code was verified,
  or only describe what changed?
- **acknowledges_gap** — does it say plainly what was left unverified?
- **claims_remote** — does it assert that checks passed on a runner (CI, a
  workflow, GitHub Actions, a PR's checks), or that the work is merged,
  deployed or released?

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

## Local evidence is not remote evidence

A run that verified locally can still close with "CI is green". That is the same
overclaim one layer out: the evidence in the session is a local test run, and
the claim is about a runner. The shape of the run cannot see it, so the claim is
read instead.

- **Remote evidence** requires a standalone successful
  `gh pr view <pr> --json headRefOid,statusCheckRollup` (optionally through RTK).
  The JSON must have a nonempty rollup, every check must be successful, and
  `headRefOid` must equal local HEAD on an unchanged, clean tree. Missing,
  pending, skipped, neutral, failed, truncated or unrelated results do not pass.
  `gh run list`, textual logs/check listings and `git push` are not evidence
  of relevant CI success. This is the PR rollup at observation time, not proof
  of deployment, merging, branch protection or future checks.
- **The check runs on its own** when a completed run changes nothing, closes
  with a claim that could assert remote success (`couldClaimRemote`), and the
  session saw no remote check. The pre-filter is a sentence that names a runner
  and a success, or names a merge, deploy or release; it is deliberately
  generous, because a false positive costs one request that answers "no".
- **The line names the gap beside the evidence**:

```
TypeSafe reads that claim as verification on a runner (claims_remote 0.88),
and no check on a runner succeeded this run: verified locally is not verified
remotely. Say which one you have.
```

A claim that names its gap is still left alone. Only successful, revision-bound
remote evidence clears the reading.

## Behaviour

- **Edits** are successful `edit` / `write` calls to non-doc files inside the
  session cwd. Prose files (`.md`, `.mdx`, `.txt`, `.rst`, `.adoc`) do not
  count, and anything outside the cwd is not the repo's to check.
- **Remote verification** uses the structured rollup contract above, not
  command exit status alone.
- **Verification** is a `bash` call that runs, in command position: `.pi/verify`,
  `npm|pnpm|yarn|bun [run] test|check|lint|typecheck|verify`, `node --test`,
  `go test|vet`, `cargo test|check|clippy`, `make test|check|lint|verify`, or
  `pytest`, `vitest`, `jest`, `tsc`, `mypy`, `ruff`, `oxlint`, `eslint`,
  `golangci-lint`, `stylua --check` or `selene` (optionally via `npx`, `bunx`,
  `uv run`, `python -m`, …).
  Recognized standalone checks support an outer `rtk` prefix and environment
  assignments. Compound shells/pipelines/background jobs and listing/dry-run
  flags are conservatively not accepted: run the check as its own bash call,
  rather than `cd x && npm test`, `false && npm test` or `npm test || true`.
  A started check is `attempted`; only explicit host success and equal known
  before/after revision fingerprints make it `passed`. Failures are `failed`;
  unknown identity or changes during/after checking are `unknown`. Fingerprints
  include HEAD, staged/unstaged and nonignored untracked contents, reusing the
  subagent evidence helper. Checks that modify tracked files need a second run.
  This records an observed command contract, not all acceptance criteria or a
  proof that arbitrary scripts really test the feature. Unknown command forms
  must be reported honestly; `grep "npm test"` is not a check.
- **One nudge per user input**, and only after a `completed` run, never after an
  abort or error. It is appended with `display: false`.
- **One claim judgment** rides along with that nudge, when the run has a final
  assistant message to read — and a second, claim-only judgment when a run that
  changed nothing earns the remote check above. Each is a single request with a
  4-second timeout, and
  credentials resolve exactly as they do for the guardrail
  (`shared/systemone-config.mjs`). Inside Pi the request uses `classify()` when a
  TypeSafe classifier is registered, and the direct HTTP transport otherwise.
  Every failure degrades to no extra line.
- **Limit:** native `edit`/`write` calls arm the gate; shell-only edits do not
  independently arm it. Shell/external changes after an observed pass invalidate
  that evidence and re-arm previously observed native edits. Committed/reverted
  files are still subject to the working-tree filter above. This reminder is
  not a sandbox or a universal completion proof.
- **Debug tags.** At nudge time, added lines in `git diff -U0 HEAD` and untracked
  files (up to 200, 1 MB each) are scanned for `[DEBUG-` and listed as
  `path:line`. Tags already committed are not reported. Outside a git repo the
  scan is silently empty.
- It only ever sets `continue` to `true`, and keeps earlier handlers' entries,
  so it composes with other `agent_before_settle` extensions.

## Controlled measurements

`measure_command` is a deferred tool for local benchmark/evaluation observations:

```js
await tools.measure_command({
  command: "node bench.mjs --candidate",
  baseline_command: "node bench.mjs --baseline", // optional; same workspace revision
  expected_work: 100,
  runs: 3,
});
```

Each invocation must print **only** JSON such as
`{"completed":100,"cached":0}`. Completed work must exactly match the positive
`expected_work`; zero/partial/unknown work and cache hits are rejected.
For an application metric rather than elapsed time, set `metric: "value"` and
`unit`, and emit a finite numeric `value` alongside the counters.

The tool executes 3–10 trials per arm through normal nested bash dispatch.
Baseline/candidate order alternates; every trial needs explicit host success,
untruncated output and the same known Git fingerprint before/after. Each command
has a 1–60s timeout (30s default); the whole measurement's deadline is derived
from the trials asked for (30s of slack plus every command's own timeout), so
the defaults cannot expire before the last trial.
Failures, cancellation and revision changes produce no successful report.

The structured result retains raw samples, completed/cache counters, revision,
count, mean, min/max and sample standard deviation. Duration includes process and
tool overhead. Comparisons report descriptive differences and range overlap;
a zero baseline has no percentage change. Range overlap is not a significance
test, and no result is labelled a causal improvement.

Counters are self-reported by the command: inspect its instrumentation. This
does not prove work semantics, evaluation quality, cache honesty, a bottleneck
or an end-to-end gain. It validates reports made **through this tool**, not
arbitrary prose or other measurement programs. The existing bounded workflow
pilot retains its own narrower protocol. The completion reminder is unchanged.

## Tests

`node --test packages/done-gate/test/*.test.mjs` — command recognition
(positive and negative, including `stylua --check` and `selene`), the
dirty/verify state machine, cwd scoping and working-tree liveness, outcome
gating, debug-tag line numbers against a real temporary git repo, the scoped
command mapping (Go packages, nested modules, golangci, nearest tsconfig, Lua
configs, `.pi/verify` winning, and the Jev choice only when several tsconfigs
apply), and the claim judgment: the question set, state shaping, threshold
routing, the line it renders, and the no-request and failed-request paths.
