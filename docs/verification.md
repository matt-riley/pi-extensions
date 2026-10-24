# Verifying pi extensions

Run `npm run check` for repository conventions, types, lint, formatting, unused
code and tests. `npm run verify` loads every root-manifest extension through a
registration stub and checks the local skill library. The stub captures
registrations; it does not dispatch events or execute tools. Missing TypeSafe
credentials are informational offline. `npm run verify -- --live` explicitly
opts into an external TypeSafe request using your configured credentials.

Run `npm run smoke` with `pi` 1.4.0 or later on PATH (or set
`PI_SMOKE_BIN` to its executable path). This uses the actual pi RPC host, loads
all manifest extensions, enters plan mode, checks that `plan_mode_question`,
`plan_mode_complete`, and `plan_fetch_url` are offered to the model, attempts a
harmless `touch smoke-blocked` command through real tool dispatch, verifies it
was blocked and that the file does not exist, exits plan mode, checks those
three tools are no longer offered, explicitly enables subagents,
and completes a scout child through the actual child-session implementation.
It then has the fixture model write a file and stop, and checks that done-gate
buys exactly one extra turn with its "Done check" message and keeps the reminder
out of the transcript (`display: false`); checks that a write outside the
workspace buys no turn; and runs `/until test -f smoke-done`, checking the agent
is sent back until the file exists.
It fails on missing capabilities, failed assertions, or a 30-second RPC timeout.

The smoke creates a temporary working directory and agent configuration, uses
an allowlisted environment, disables discovery/MCP/startup networking, and
serves scripted OpenAI-compatible responses on loopback only. It needs no
provider credentials and incurs no external model cost. Child sessions use the
same temporary agent directory. TypeSafe requests, if attempted, point at the
local fixture via `TYPESAFE_BASE_URL` and exercise the existing unavailable-judge
fallback. An explicit base URL overrides the classifier's catalog host, so a
registered TypeSafe model still does not call `api.typesafe.ai` during smoke.
`scripts/` classifiers have no Pi registry and keep the direct HTTP transport
against that same base URL. Normal user settings and sessions are not changed.
The host, server and fixtures are cleaned up in `finally` on normal success or
failure. Forced process termination can leave a `pi-smoke-*` directory in the
system temporary directory.

This smoke checks host integration and extension behavior, not model judgment,
interactive rendering, external providers, or successful TypeSafe judgments.
For an explicitly authorized live/UI check, start pi in a disposable directory
with a separate `PI_CODING_AGENT_DIR`, provision only the intended provider
credential there, and repeat `/plan start`, the harmless blocked bash command,
`/plan exit`, `/subagents on`, and a child request. Record the actual tool result
and child completion. Do not count a provider response or the registration stub
as evidence that the blocked action or child execution worked.

## Project recipe

Target: record the requested base/head and `git rev-parse HEAD` before running.
For uncommitted work include staged, unstaged and untracked content identity;
subagent results provide `assessment.revision.fingerprint` when Git is available.
Any intervening edit invalidates earlier evidence for the final state.

| Step | Command / fixture | Expected observation |
| --- | --- | --- |
| Setup | `npm ci` only when dependency installation is authorized; otherwise use the existing installation | Node, dev tools and `pi` are available; report missing setup |
| Static and behavior checks | `npm run check` | Exit 0; all repository checks and tests pass |
| Registration | `npm run verify` | Every manifest entry registers; no live TypeSafe call |
| Host startup and fixture | `npm run smoke` starts pi RPC and its disposable local provider | All manifest extensions load in the actual host |
| Changed behavior | Smoke attempts `touch smoke-blocked` during `/plan start`, then exits and runs a child | The three plan tools are offered inside plan mode and gone after exit; the tool is blocked, file absent, real child completes; done-gate continues once, quietly, and not for an outside-cwd write; `/until` loops to its predicate |
| Jev question sets | Part of `npm run check`: `node --test scripts/jev-questions.test.mjs` | Every call site's questions pass the production validator against the state its caller builds; a case that silently asks nothing is itself a failure |
| Jev decision ledger | Part of `npm run check`: `packages/typesafe/test/ledger.test.mjs` and `scripts/judge-thresholds.test.mjs` | A call appends a local `jev-decision` entry and does not store state, question text, or the API key; a drifted reported model warns once; guardrail entries export to the replay-corpus shape without the command |
| Judgment quality, live | `node scripts/judge-live.mjs` | Exit 0 when every labelled case reached the judge; the labels are printed for a human to read, because a model's reading is a hypothesis and the wiring is what the unit tests prove |
| Judgment paths, live | `node scripts/judges-live.mjs` (or `--only <name>`) | Exit 0 when every judgment path reached its judge: review lint, findings verification, `web_answer`, plan review, CI triage, correction promotion. Each line prints what came back; the readings are a model on a fixture, not ground truth. Costs one real request per case, so it is not part of `npm run check` |
| Cleanup | Smoke's `finally` closes processes/server and removes temporary files | No user config/session edits; report cleanup failure |

Choose additional acceptance-specific checks for changes outside that smoke's
coverage. A green registration stub alone is insufficient. For UI/native work,
use an explicitly configured project verifier with those tools or report the
capability gap. No universal extra tool grant is implied by this recipe.
