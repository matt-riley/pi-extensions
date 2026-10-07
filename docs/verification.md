# Verifying pi extensions

Run `npm run check` for repository conventions, types, lint, formatting, unused
code and tests. `npm run verify` loads every root-manifest extension through a
registration stub and checks the local skill library. The stub captures
registrations; it does not dispatch events or execute tools. Missing TypeSafe
credentials are informational offline. `npm run verify -- --live` explicitly
opts into an external TypeSafe request using your configured credentials.

Run `npm run smoke` with a supported `pi` executable on PATH (or set
`PI_SMOKE_BIN` to its executable path). This uses the actual pi RPC host, loads
all manifest extensions, enters plan mode, attempts a harmless `touch
smoke-blocked` command through real tool dispatch, verifies it was blocked and
that the file does not exist, exits plan mode, explicitly enables subagents,
and completes a scout child through the actual child-session implementation.
It then has the fixture model write a file and stop, and checks that done-gate
buys exactly one extra turn with its "Done check" message; and runs
`/until test -f smoke-done`, checking the agent is sent back until the file exists.
It fails on missing capabilities, failed assertions, or a 30-second RPC timeout.

The smoke creates a temporary working directory and agent configuration, uses
an allowlisted environment, disables discovery/MCP/startup networking, and
serves scripted OpenAI-compatible responses on loopback only. It needs no
provider credentials and incurs no external model cost. Child sessions use the
same temporary agent directory. TypeSafe requests, if attempted, point at the
local fixture and exercise the existing unavailable-judge fallback. Normal user
settings and sessions are not changed. The host, server and fixtures are cleaned
up in `finally` on normal success or failure. Forced process termination can
leave a `pi-smoke-*` directory in the system temporary directory.

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
| Changed behavior | Smoke attempts `touch smoke-blocked` during `/plan start`, then exits and runs a child | Tool is blocked, file absent, real child completes; done-gate continues once; `/until` loops to its predicate |
| Cleanup | Smoke's `finally` closes processes/server and removes temporary files | No user config/session edits; report cleanup failure |

Choose additional acceptance-specific checks for changes outside that smoke's
coverage. A green registration stub alone is insufficient. For UI/native work,
use an explicitly configured project verifier with those tools or report the
capability gap. No universal extra tool grant is implied by this recipe.
