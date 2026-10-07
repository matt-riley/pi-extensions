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
