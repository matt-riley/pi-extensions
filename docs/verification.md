# Verifying pi extensions

Start with the check that answers your question. A passing unit suite does not
prove that pi loads an extension, and a registration stub does not prove that a
tool works in the real host.

The full runnable recipe is [`.pi/verify/SKILL.md`](../.pi/verify/SKILL.md).
It covers setup, host/UI drives, expected results and cleanup. This page explains
what those checks establish—and where they stop.

## Choose a check

Run these from the repository root:

| Command | What it proves | What it does not prove |
| --- | --- | --- |
| `npm run check` | Conventions, types, lint, formatting, unused-code gates and tests pass. | That the real pi host loads or runs the extensions. |
| `npm run verify` | Every root-manifest extension registers through a stub; bundled skills are checked. | Event handling, tool execution or model behaviour. Missing TypeSafe credentials are informational offline. |
| `npm run smoke` | Extensions and resources work through a real pi RPC host with scripted local responses. | Real model judgment, external providers or interactive rendering. |
| `node .pi/verify/local-commands.mjs` | Skill search, empty-branch usage reports and `/workflow` discovery in the real host, without a listener or model calls. | Prompt expansion, nonzero usage accounting or the interactive skill picker. |
| `npm run coverage` | Unit, registration and smoke coverage through Node's LCOV reporter. | Coverage of unsupported or unmatched files, or hosted CI success. |

Smoke needs pi 1.4.0 or later on PATH (`PI_SMOKE_BIN` can name another executable).
Coverage needs pi too and supports Node 24+; generated coverage files are ignored
by Git. Run the final checks on the final revision, and distinguish local results
from hosted CI.

`npm run verify -- --live` makes one real TypeSafe request with your configured
credentials. It is opt-in, not part of the offline registration check.

## What the smoke exercises

The smoke loads all manifest extensions, bundled workflow skills and prompt
templates from an unrelated working directory. A local scripted provider drives
these paths:

- **Resource discovery:** skill and prompt loading/expansion, including
  `/workflow`; `/skill-search` and `/usage --json` without provider calls.
- **Plan mode:** its three tools appear on entry and disappear on exit. A real
  `touch smoke-blocked` tool call is denied, and the file remains absent.
- **Subagents:** explicit opt-in and a completed scout through real child-session
  construction, with execution completion kept separate from task verification.
- **Completion:** done-gate gives one extra turn for an unverified workspace edit,
  keeps its reminder out of the visible transcript, and ignores an outside write.
  `/until` resumes work until its target file exists.
- **Measurements and diagnosis:** controlled trials reject empty work. Two failed
  revised checks block native, shell and nested writes; an executed diagnostic
  observation releases the gate and a subsequent write succeeds.
- **Background jobs:** a real failed job reports its exit status/output; completion
  resumes the agent once without steering. The optional Jev watch uses redacted
  fixtures, and `notify: false` must not start another turn.
- **Semantic search and warnings:** deferred `find_code` runs through codemode;
  URL credentials are redacted at the TypeSafe HTTP boundary. A structured
  MCP-shaped fixture checks warning propagation without changing the schema.
  It is not an actual MCP transport test.

Missing capabilities, failed assertions and a 30-second RPC timeout fail the
smoke. Scripted model answers prove wiring, not the accuracy of Jev or the main
model. A watch hint is inference, not verification.

## Isolation and cleanup

Smoke creates a temporary workspace and agent configuration, disables discovery,
MCP and startup networking, and serves scripted responses on loopback only.
It needs no provider credentials and incurs no external model cost. Children
use the same temporary agent directory. TypeSafe requests use the local fixture,
even if a registered classifier has a different catalog host; standalone
classifiers use HTTP against that same fixture.

The fixture supplies typed answers for semantic search and injection screening.
Other phases exercise the unavailable-judge fallback. Normal user settings and
sessions are untouched. Processes, servers and files are removed in `finally`;
forced termination can still leave a `pi-smoke-*` directory in the system temp
directory, so check cleanup after an interrupted run.

## When you need more than smoke

For UI or native terminal changes, use the real-terminal drives in the recipe
below. For an explicitly authorized live check, start pi in a disposable directory
with a separate `PI_CODING_AGENT_DIR` and only the intended provider credential.
Exercise the affected actions and record raw tool results and child completion,
not just a model's summary. A provider response alone does not prove that a
blocked write was blocked or a child actually ran.

## Project recipe

Target: record the requested base/head and `git rev-parse HEAD` before running.
For uncommitted work include staged, unstaged and untracked content identity;
subagent results provide `assessment.revision.fingerprint` when Git is available.
Any intervening edit invalidates earlier evidence for the final state.

| Step | Command / fixture | Expected observation |
| --- | --- | --- |
| Setup | `npm ci` only when dependency installation is authorized; otherwise use the existing installation | Node, dev tools and `pi` are available; report missing setup |
| Static and behavior checks | `npm run check` | Exit 0; all repository checks and tests pass |
| Registration | `npm run verify` | Every manifest entry registers; each owned workflow ranks for its sample task; no live TypeSafe call |
| Workflow resources | `npm run smoke` | Three owned skills and review/test/design/refactor prompts discover and expand in a fresh host outside this repo; no imported personal skill collection |
| Coverage and change risk | `npm run coverage`, then `crap packages/skill-select scripts --diff --coverage coverage/lcov.info` and `deadwood . --fail-on high` | Nonempty LCOV matches changed JS modules; inspect changed-function coverage, CRAP and unused-code findings. Report tool limitations rather than scoring unmatched files as covered |
| Host startup and fixture | `npm run smoke` starts pi RPC and its disposable local provider | All manifest extensions load in the actual host |
| Failed-fix and measurement contracts | `npm run smoke` plus `node --test packages/diagnosis-nudge/test/checkpoint.test.mjs packages/done-gate/test/measurement.test.mjs` | Native/shell/nested mutations pause after two failed revised checks; executed checkpoint recovers; invalid evidence cannot unlock or generate a measurement report |
| Changed behavior | Smoke attempts `touch smoke-blocked` during `/plan start`, then exits and runs a child | The three plan tools are offered inside plan mode and gone after exit; the tool is blocked, file absent, real child completes; done-gate continues once, quietly, and not for an outside-cwd write; `/until` loops to its predicate |
| Jev question sets | Part of `npm run check`: `node --test scripts/jev-questions.test.mjs` | Every call site's questions pass the production validator against the state its caller builds; a case that silently asks nothing is itself a failure |
| Jev decision ledger | Part of `npm run check`: `packages/typesafe/test/ledger.test.mjs` and `scripts/judge-thresholds.test.mjs` | A call appends a local `jev-decision` entry and does not store state, question text, or the API key; a drifted reported model warns once; guardrail entries export to the replay-corpus shape without the command |
| Judgment quality, live | `node scripts/judge-live.mjs` | Exit 0 when every labelled case reached the judge; the labels are printed for a human to read, because a model's reading is a hypothesis and the wiring is what the unit tests prove |
| Judgment paths, live | `node scripts/judges-live.mjs` (or `--only <name>`) | Exit 0 when every judgment path reached its judge: review lint, findings verification, `web_answer`, plan review, CI triage, correction promotion. Each line prints what came back; the readings are a model on a fixture, not ground truth. Costs one real request per case, so it is not part of `npm run check` |
| Workbench/footer, real terminal | `node .pi/verify/workbench.mjs --upgrade` and `node .pi/verify/workbench.mjs --regular` | Exit 0 in both modes: isolated tmux terminal with real pi and Neovim, local scripted provider, footer upgrade/reload, live filter/select/cancel, recoverable drafts across reload, file references, non-editable staged/unstaged diffs, next/previous navigation with retained query/selection/scroll, read-only Neovim handoff, `/eixt` interception without execution or model calls, Unicode/narrow resize, and actual working → ready state. No personal config or credentials; fixture/server/socket removed in `finally`. Does not prove every terminal forwards Ctrl+Alt identically or exercise Matt's Neovim plugins. The target is the current working tree and printed HEAD, not a hosted revision. |
| Background jobs, real terminal | `node .pi/verify/jobs.mjs` | Real Pi live logs, follow/scroll/resize/cancel, same-PTY input and detach/reattach, Ctrl+C to the program, explicit human line input, real failed exit status, and owned-process cleanup across reload/session/shutdown. Isolated tmux is only the test terminal, not an extension dependency; no personal config or model requests. |
| Cleanup | Smoke's `finally` closes processes/server and removes temporary files | No user config/session edits; report cleanup failure |

The current `deadwood` build does not scan this repository's `.mjs` modules
and reports unresolved sibling imports plus the intentionally host-provided Pi
SDK as missing dependencies. Its failure is not a useful dead-code verdict here;
record that limitation and use the repository's Knip/Fallow gates rather than
adding runtime dependencies or suppressions to satisfy it.

Choose additional acceptance-specific checks for changes outside that smoke's
coverage. A green registration stub alone is insufficient. For UI/native work,
use an explicitly configured project verifier with those tools or report the
capability gap. No universal extra tool grant is implied by this recipe.
