# pi-done-gate: no "done" on faith

Reminds the agent to run checks when it tries to finish with unverified code
changes. It gives the model one more turn to check its work or explain what it
could not verify. It does not block tools or guarantee the code is correct.

There is nothing to configure after you [install the collection](../../README.md#install).
The reminder goes to the model, not into your visible transcript. For example:

```
Done check: 1 file(s) changed after the last verification run (pkg/foo/a.go).
Before reporting done, run `go test ./pkg/foo` and `golangci-lint run ./pkg/foo`
as separate commands, and exercise the changed behavior, or say plainly why
verification does not apply. Then close with your explanation of the work plus
one line naming the check that reached the changed code and what it showed, not
a report about this reminder.
```

The reminder names checks for Go, TypeScript and Lua when it can find the right
commands. Otherwise it asks for the repository checks (`.pi/verify` if present).
It also flags leftover `[DEBUG-` tags. With TypeSafe credentials, it can add a
warning when the closing message claims more than the recorded checks support.
The basic reminder works without a key.

The sections below explain when it fires, which checks count, and where the
evidence stops. For repeated local benchmarks, see [Controlled measurements](#controlled-measurements).

## What arms the gate

Only successful code edits in the current workspace can trigger the reminder.
Documentation-only changes do not. More precisely:

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
Redirecting a check's output (`npm run check 2>&1`, `> log 2>&1`) does not make it compound. A pipe
(`| tail`) or a chain (`; echo done`, `|| true`) does, because it can hide the check's exit status.

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

A change that matches none of this (a Python file, a `go.mod`, a TypeScript
file with no tsconfig) keeps the generic sentence.

## Running the named checks (opt-in)

By default the reminder only names the commands. Set `PI_DONE_GATE_EXEC=1` (exactly
`1`; unset or any other value is off) and the gate also runs the command(s) it
worked out for the dirty files, in order, in the session cwd, and appends each
command's status, exit code and output to the reminder. It runs only commands the
reminder names (`.pi/verify` or the Go, TypeScript and Lua mapping), never
anything the model wrote.

It is bounded and cancellable: 120 seconds per command, the last 4,000
characters of output per command (where a failing check says why), at most four
commands, and a cancelled session stops the running command and starts no later
one. Each command runs in its own process group, so a timeout takes its children
with it.

Two things to know before turning it on. `.pi/verify` and the language tools run
repository-controlled code, which is why this is off by default. And the commands
run directly, not through a bash tool call, so the guardrail extension does not
see them. A run by the gate is not recorded as a verification run: the agent is
still asked to run the checks itself, or to say what the output shows.

## Evidence that the changed path ran

A passing build says the code compiles. It does not say the changed code ran. So the gate sorts
the checks it recognises into two kinds:

- **Compile or lint:** `tsc`, `eslint`, `oxlint`, `ruff`, `mypy`, `golangci-lint`, `go vet`,
  `cargo check`, `cargo clippy`, `deno check`, `deno lint`, and `npm run lint` or `typecheck`.
- **Everything else it recognises:** tests, `.pi/verify`, `npm run check`, `npm run smoke`,
  `./scripts/test.sh` (and other `scripts/test|check|verify|smoke` scripts), `make test`, `deno
  test` and the rest. `stylua --check` and `selene` are in this group because they are the only checks the gate
  maps for Lua, so there is no test run to ask for instead.

A compile or lint pass alone leaves a code edit unverified, and the reminder says so: "only compile
or lint checks ran ... that shows the code builds, not that the changed path ran". It then asks for
a test that reaches the changed code, or for the changed path itself (the command, request or
screen it serves). It names only the checks that run code, since the typecheck is already done.

A compile or lint pass does clear the edit in two cases: every changed file is a type declaration or
compile or lint configuration (`*.d.ts`, `tsconfig*.json`, `.oxlintrc*`, `eslint.config.*` and
similar), because compiling is the change; or a check that runs the code already passed on this
tree. A later edit starts again.

The reminder also asks the closing message to name the check that reached the changed code and say
what it showed.

### A unit-test run must reach the change

A green test run says nothing about a file that no test touches. So a unit-test run clears an edit
only when a test file it ran **imports or names** one of the changed files. The gate reads the test
files as plain text and checks, for each one:

- **Imports:** an `import`, `export ... from`, `import()` or `require()` specifier (or a Python
  `import` or `from ... import`) that resolves to a changed file. Relative paths are resolved from
  the test file, and the extension is ignored, so `./a.js` reaches `a.ts` and `../src` reaches
  `src/index.ts`. A module name such as `pkg.mod` or `app/core` matches the end of a changed path.
- **Names:** the test's text contains the changed path, or the file name with its extension
  (`bin/tool.mjs`, `"gate.mjs"`). A file called `index.ts` must match with its parent folder.

One covering file among those that ran is enough. A changed test file that ran counts too. There is
no dependency graph: a test that reaches the change only through another module does not count, and
the reminder then asks for a test that imports or names the code, or for the changed path itself.

Which test files ran is worked out from the command and the log. Paths in the command are used,
with directories and globs expanded against the repo's test files. A bare `node --test`, `pytest`,
`vitest`, `jest`, `mocha` or `deno test` takes every test file. `npm test` (or `npm run test:unit`)
is read through the script in `package.json`. Test files that the log prints (`PASS src/a.test.ts`)
are added. `go test` is judged by package: a `_test.go` file in the same directory as the changed
file counts, and a package with no tests does not.

**When the files cannot be worked out** (`cargo test`, `make test`, `dotnet test`, an `npm test`
script that is not a recognised runner, with no file names in the log), the run does not count, and
the reminder says it could not tell which test files ran. That is the cautious choice. To keep it
quiet, the reminder is still sent only once per user input, it asks for a command that names the test
files (`node --test path/to/x.test.mjs`) rather than for more work, and the changed path itself is an
accepted alternative. A test file that cannot be read gives the same answer, never a miss.

Only edits to code are judged this way. Prose, JSON, YAML and other files that a test cannot import
are cleared by any passing test run, as before. Scripts such as `.pi/verify`, `npm run check`,
`npm run smoke` and `./scripts/test.sh` are whole-repo checks and are not read this way.

### A "tests passed" claim must match the log

The gate keeps each check it sees: the command, its kind, whether it passed on the final tree, and
the last 4,000 characters of its log. That includes `!` runs, so this extends [your own `!`
runs](#your-own--runs) rather than running beside them. When the closing message plainly says the
tests passed, plain code (no key, no model request) compares it with those records. Any of these
adds one line to the reminder, or sends one if nothing else would:

- No check that runs the code was recorded after the edits, or only compile and lint checks were.
- The newest check that runs the code failed, or has no clean result on the final tree.
- Its log reports failures even though it exited 0. Only the runner's summary lines count
  (`# fail 2`, `Tests: 1 failed`, `test result: FAILED`, `--- FAIL`, `2 failing`, a line that
  starts with `FAIL`). A test whose name mentions "3 failures" is not a failure report.
- Its log shows no tests ran (`# tests 0`, `collected 0 items`, `No tests found`) and no part of the
  log shows tests passing. A runner that ends on an empty section after a full one, such as cargo's
  empty Doc-tests, is fine.
- The message states the run's total (`all 12 tests pass`, `12/12`, `12 tests passed`) and the log
  never shows that number. A count of what the work added or touched (`I added 3 tests`, `updated 2
  test files`) is not compared.

A sentence that hedges ("all tests pass except the timing ones", "I did not run the tests") is left
alone, and so is a claim on a turn that changed no code and ran no check. The line is sent once per
user input. The log is only the tail of the output, and the check cannot read a number written as
words, so it will miss some mismatches. It would rather stay quiet than guess.

## Your own `!` runs

A check you run yourself with `!npm test` counts as the verification the gate
wants, with the same compile-versus-run rule as above (`!npm run lint` alone does not). Pi saves the run as a `bashExecution` message when it finishes;
that message is the only thing trusted. It counts when all of these hold:

- the command is a recognised check (the same list as above),
- it exited 0, was not cancelled, and its output was not truncated,
- it was not `!!` (`excludeFromContext`): that output never reached the model,
- and the working tree now is the tree it started on (the `shared/revision.mjs` fingerprint), so
  neither an edit since nor the run itself changed the code.

`user_bash` is used only to remember the tree when a run starts. It is never counted from, and the
handler never intercepts the command. A saved run with no recorded start (after `/reload`) is not
counted. The newest recognised run decides: a later failing `!` run undoes an earlier pass.

Limit: the gate's state resets at each prompt, and Pi saves a `!` run typed during a run only after
it ends, so this helps only when the run is saved before the run settles. It does not try to order
your `!` runs against the agent's own check results; a pass from either counts.

## Why `agent_before_settle`

A `tool_result` patch (how `pi-diagnosis-nudge` works) lands mid-run, before
the model has decided it is finished. `agent_before_settle` is the last boundary
that can still act: the handler appends a `custom_message` entry and returns
`continue: true` for exactly one more model request, so the reminder is read
before the turn closes instead of after the user has already seen "done".

`display: false` keeps that message out of the terminal. Per
`message-types.md`, `display` controls rendering only. Pi still converts the
entry to a user message for the next request, so the enforcement is unchanged
and the transcript keeps the explanation and the checks, not a meta block.

It never blocks a tool call. The model may answer the nudge by running the
checks or by saying why they do not apply.

## The claim judgment

The basic reminder tracks edits and checks, not the meaning of the closing
message. When it fires and the run has a final assistant message, that message
also goes to TypeSafe's System One
(`jev-1.13.0` unless `TYPESAFE_MODEL` says otherwise) as three typed questions:

- **asserts_verified**: does the message claim the changed code was verified,
  or only describe what changed?
- **acknowledges_gap**: does it say plainly what was left unverified?
- **claims_remote**: does it assert that checks passed on a runner (CI, a
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
answer. The judgment is one extra sentence or silence, never a block and never an
error in the settle path. Thresholds and routing live in `claim.mjs`, not in a
prompt, and `judgeDoneClaim` takes an injectable `ask` so the tests never touch
the network.

## Local evidence is not remote evidence

Passing local tests does not prove that CI passed. The optional claim check
looks for this distinction too: a closing message saying "CI is green" needs
recorded evidence from that runner.

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
  assistant message to read, and a second, claim-only judgment when a run that
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

`node --test packages/done-gate/test/*.test.mjs`: command recognition and kind (compile or lint versus runs the code), the evidence check on a tests-passed claim (failed run, failure and zero-test logs, count mismatch, hedged claims),
(positive and negative, including `stylua --check` and `selene`), the
dirty/verify state machine, cwd scoping and working-tree liveness, outcome
gating, debug-tag line numbers against a real temporary git repo, the scoped
command mapping (Go packages, nested modules, golangci, nearest tsconfig, Lua
configs, `.pi/verify` winning, and the Jev choice only when several tsconfigs
apply), and the claim judgment: the question set, state shaping, threshold
routing, the line it renders, and the no-request and failed-request paths.
