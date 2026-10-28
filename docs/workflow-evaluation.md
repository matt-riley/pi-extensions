# Bounded workflow outcome pilot

`node scripts/workflow-eval.mjs --live --output /tmp/pi-workflow-pilot-<unique>`
opts into real calls to the physical default pi model. Without `--live` it only
prints usage. It copies only that provider's credential into private disposable
configuration and deletes the copy after each run; no user settings are changed.

This pilot compares the pre-change verifier prompt at HEAD with the current
verifier plus an explicit project recipe reference. It tests a narrow
verification intervention, not all extensions or the value of subagents.
Four frozen executable CLI verification tasks include good and defective
implementations; two are held out from prompt development. Both variants receive
the same acceptance criteria and files. Existing shallow tests pass even when
an edge case is defective. Independent execution scores the verdict and unchanged
fixture, not an LLM judge. These controlled fixtures are not production tasks.

Budget: eight sessions total, six turns/90 seconds per session, 2048 model output
tokens per response where the provider honors the model override. Stop scheduling
runs once reported cost reaches $2; one in-flight run can exceed that soft cost
ceiling. Turn/time/run limits remain hard when cost is unavailable. No optimization
or correction retries; only a demonstrated harness defect justifies rerunning.
Alternate variant order. Freeze case/prompt hashes before requests. No background
watcher or automatic promotion follows the pilot.

Artifacts contain protocol, frozen prompts/cases, real tool events, final outputs,
fixture directories, acceptance verdicts, elapsed time and reported token/cost
usage. Treat provider cost as an estimate; zero or missing cost is not proof of
free usage. Human corrections and rework are unmeasured (null), not zero. One run
per case/variant cannot establish statistical improvement or model generality.
Inspect failure transcripts before changing prompts; reserve a fresh held-out
set for any subsequent optimization. Retain useful checks, delete ineffective
instructions, and do not claim improvement from this integration smoke alone.

## Lightweight outcome record

For an explicitly chosen workflow experiment, append one manual row per real
task to its existing artifact or notes: task/revision, workflow variant,
acceptance commands and results, accepted/rejected/unknown outcome, observed
human corrections, observed rework, elapsed time and available token/cost data.
Use `null` for observations not collected; do not turn unknown corrections or
cost into zero. Keep comparable scope and inspect failure transcripts before
changing a rule. No background telemetry or mandatory pilot for ordinary tasks.
A green integration test demonstrates wiring, not improved productivity.

## Recorded pilot: 2026-10-07

Executed eight real `deepseek/deepseek-flash` sessions, thinking off. Frozen
protocol, hashes, command results and final responses are preserved in
`workflow-evaluation-results.json`; full raw events and fixture Git repositories
remain at `/tmp/pi-workflow-pilot-20261007-r2` (temporary, not archival).

| Variant | Correct verdicts | Strict accepted runs | Total time | Reported cost | Tokens |
| --- | --- | --- | --- | --- | --- |
| Prior verifier | 4/4 | 4/4 | 26.677 s | $0.006501 | 41,765 |
| Current verifier + recipe | 4/4 | 3/4 | 35.544 s | $0.009309 | 62,272 |

Both variants correctly detected both defects, including the held-out defect.
There is no observed detection improvement. The candidate used more time/tokens
on these tiny tasks. Its held-out good case emitted the correct final answer at
turn six, then the harness killed it at the turn boundary. That is a conservative
normal-completion failure with cap ambiguity, not a wrong verification verdict.
Do not add another live rerun to make the result look better.

The initial setup-only attempt stalled on inherited Git signing before any model
call. Fixture commits now disable signing locally. An initial scorer also missed
an actual command piped to `od`; all stored logs were rescored with the same
quote-aware command recognizer and original scores retained, with no new calls.
The matcher is a conservative heuristic, not proof of arbitrary shell semantics; these recorded accepted invocations were also inspected. It remains deliberately narrow; unsupported command forms require
manual evidence review, never an automatic successful score.

Use project recipes where setup or acceptance is easy to miss. This pilot does
not justify mandatory elaborate ceremony on tiny tasks, nor a claim that the
entire agent system is better. Human correction/rework rates are unmeasured.

## Subagent usage report

Which built-in types are worth keeping is a measurement, not a guess. On the
machine that has the sessions (they are not in this repo):

```text
node scripts/subagent-usage-report.mjs
node scripts/subagent-usage-report.mjs --json
node scripts/subagent-usage-report.mjs --since 2026-01-01 --limit 50
node scripts/subagent-usage-report.mjs --sessions ~/.pi/agent/sessions
```

The default directory is `~/.pi/agent/sessions`. `--since` is a UTC date
(`YYYY-MM-DD` or any `Date.parse` value) and keeps sessions with activity on
or after that instant, then drops spawns that started earlier. `--limit` keeps
the newest N of those session files. The script is read-only: it never writes
into the sessions directory.

It reads two things the subagents extension already records. Parent sessions
are Pi JSONL. Each spawn is a `subagent` tool call; tokens come from that tool
result's `usage` (`totalTokens`, otherwise `input + output + cacheRead +
cacheWrite`, the same total as `tokensFromUsage`). Duration is the wall clock
from the assistant message that issued the call to the tool result. `usage`
has no duration field, so this interval includes preflight and triage as well
as the child. Jev ledger entries are the `custom` / `jev-decision` records
`askSystemOne` appends, with `feature: "subagents"`. Question ids distinguish
the three calls: `self_contained` is preflight, `outcome` is triage,
`out_of_scope` is scope. Triage stores a choice index, not the label. The
index follows the criteria order in `triageQuestions()`: `answered`,
`partial`, `blocked`, `off_task`.

A fan-out is two or more children that all started before the first of them
finished. Calls from one assistant message share a start, so they are a
fan-out. Every other spawn is lone sequential. A preflight rejection (`Task
rejected:`) and an `isError` result are not spawns. A ledger entry whose
`outcome` is not `ok` contributes no label.

Lossy handoff is an approximate telephone-game signal: after the child
returns, and before the next user message, the parent calls `read` on a path
the child also `read`. Paths are resolved against the session cwd, hashed, and
never printed. `grep`, `bash`, and a `read` issued in the same turn as the
spawn do not count. The child's reads come from the transcript path on
`details.transcript` (or the `transcript:` line), usually
`~/.pi/agent/subagent-runs/*.jsonl`. A missing transcript counts as no
handoff, so the rate is a lower bound.

Fold candidates are types with more lone sequential spawns than fan-out
spawns, and more `partial` or `blocked` labels than `answered` or `off_task`.
A tie is not enough. Types with no triage labels are not candidates. Built-in
names come from `packages/subagents/agents/*.md` and are listed even at zero;
any other type name seen on a spawn is appended.

Output is counts and those definitions only. Prompt text, file contents, file
paths and tool arguments are not printed. `--json` is the same report.
