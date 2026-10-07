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
