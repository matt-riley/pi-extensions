# Verifying pi extensions

Run `npm run check` for repository conventions, types, lint, formatting, unused
code and tests. `npm run verify` loads every root-manifest extension through a
registration stub and checks the local skill library. The stub captures
registrations; it does not dispatch events or execute tools. Missing TypeSafe
credentials are informational offline. `npm run verify -- --live` explicitly
opts into an external TypeSafe request using your configured credentials.

Run `npm run smoke` with `pi` 1.4.0 or later on PATH (or set
`PI_SMOKE_BIN` to its executable path). This uses the actual pi RPC host, loads
all manifest extensions, the owned workflow skills and prompt templates. It
checks discovery and expansion of those resources from an unrelated working
directory using the local provider, then enters plan mode, checks that
`plan_mode_question`, `plan_mode_complete`, and `plan_fetch_url` are offered to
the model, attempts a harmless `touch smoke-blocked` command through real tool
dispatch, verifies it was blocked and that the file does not exist, exits plan
mode, checks those three tools are no longer offered, explicitly enables
subagents,
and completes a scout child through the actual child-session implementation.
It then has the fixture model write a file and stop, and checks that done-gate
buys exactly one extra turn with its "Done check" message and keeps the reminder
out of the transcript (`display: false`); checks that a write outside the
workspace buys no turn; and runs `/until test -f smoke-done`, checking the agent
is sent back until the file exists.
The isolated host also loads built-in codemode explicitly. It runs controlled
measurement trials and rejects empty work, then fails the same check after two
distinct edits. It checks that native writes, shell writes and both nested
variants are blocked with files absent, executes a real diagnostic observation,
and checks that a subsequent write succeeds.
It also runs deferred `find_code` from codemode against a local TypeSafe
fixture, checks URL-userinfo redaction at that HTTP boundary, and uses a
structured MCP-shaped tool fixture (not an actual MCP transport) to check
warning propagation to the outer codemode result without changing its schema.
It fails on missing capabilities, failed assertions, or a 30-second RPC timeout.

The smoke creates a temporary working directory and agent configuration, uses
an allowlisted environment, disables discovery/MCP/startup networking, and
serves scripted OpenAI-compatible responses on loopback only. It needs no
provider credentials and incurs no external model cost. Child sessions use the
same temporary agent directory. TypeSafe requests point at the local fixture:
semantic-search and injection-screen phases receive scripted typed answers;
other phases exercise the existing unavailable-judge fallback. An explicit base
URL overrides the classifier's catalog host, so a registered TypeSafe model
still does not call `api.typesafe.ai` during smoke. `scripts/` classifiers have
no Pi registry and keep the direct HTTP transport against that same base URL.
Normal user settings and sessions are not changed. The host, server and fixtures
are cleaned up in `finally` on normal success or failure. Forced process
termination can leave a `pi-smoke-*` directory in the system temporary directory.

`npm run coverage` runs the unit suite, offline registration verifier and real-Pi
smoke under Node's built-in LCOV reporter, so it requires `pi` on PATH too. It
works on Node 24+ without `--test-coverage-include-all` (which is Node 26-only). Generated coverage
is ignored by Git. Run from a clean state on the CI runtime too; a local green
result is not evidence of hosted CI success.

This smoke checks host integration and resource/extension wiring, not whether
a model follows a skill well, model judgment,
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
| Workbench/footer, real terminal | `node .pi/verify --upgrade` and `node .pi/verify --regular` | Exit 0 in both modes: isolated tmux terminal with real pi and Neovim, local scripted provider, footer upgrade/reload, native search/select/cancel, recoverable drafts across reload, file references, staged/unstaged previews, read-only editor handoff, Unicode/narrow resize, and actual working → ready state. No personal config or credentials; fixture/server/socket removed in `finally`. Does not prove every terminal forwards Ctrl+Alt identically or exercise Matt's Neovim plugins. The target is the current working tree and printed HEAD, not a hosted revision. |
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
