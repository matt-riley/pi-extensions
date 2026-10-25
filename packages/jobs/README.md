# pi-jobs

Pi-native background commands, live logs and optional interactive PTYs. No herdr,
tmux or installed runtime dependency. Commands use Bash; PTYs additionally need
the native `script` and `stty` utilities on macOS/Linux.

## Human controls

- `/jobs run <command>` — start a pipe-based job without involving the model.
- `/jobs pty <command>` — start an interactive terminal.
- `/jobs` — choose a job; `/jobs <id>` opens it directly.

The live log overlay follows output. Arrows/PageUp/PageDown/Home/End scroll;
`f` toggles following. `i` sends one line, `s` confirms a stop, `x` forgets a
finished job, and Escape returns. Typing in the log viewer never goes to the
process.

`a` hands the **same running PTY** to your terminal while Pi is idle.
Ctrl+] detaches back to Pi; Ctrl+C goes to the program. The agent cannot send
input or stop that job while you own it. Resizes propagate to the PTY.
This is a native terminal handoff, not an embedded terminal emulator: reattach
asks the program to redraw, but cannot reconstruct an arbitrary prior screen.
Use takeover, not agent input, for passwords and sensitive consent prompts.

Jobs are session-owned, not daemons. Reload, session changes and shutdown stop
them; they do not survive restarting Pi. Run commands in the foreground, without
`&`/daemonizing. Cleanup terminates owned process groups and escalates if needed;
it is not a sandbox against programs deliberately escaping their process group.

## Agent tools

All five tools are deferred under the `terminal` namespace:

| Tool | Input |
| --- | --- |
| `terminal_start` | `command`, optional `pty`, `watch`, `notify` |
| `terminal_read` | `id`, optional `wait_seconds` (0–30), `lines` (1–1000) |
| `terminal_list` | no arguments |
| `terminal_send` | `id`, optional `text` and `keys` |
| `terminal_stop` | `id`, optional `forget` |

Input is limited to 8,192 characters and sixteen keys per call.
Keys: enter, tab, esc, backspace, ctrl+c, ctrl+d, ctrl+z, and the four arrows.
Only ids belonging to this session are accepted; raw PIDs are not controls.
At most four jobs run concurrently; twenty retained jobs; 64,000 characters per
log. Read log tails contain at most 12,000 characters. Older output is discarded with
`truncated: true`, not silently written to disk. Log views strip terminal
controls; native takeover deliberately forwards the terminal stream.

By default, an agent-launched job sends one follow-up on exit, waking the agent
to inspect it. `notify: false` is UI-only; slash-command launches use that mode.
Follow-ups wait while any job is under human control. Unrelated work does not
get interrupted by steering.

With this collection's guardrail loaded, launches follow the existing shell
policy; every terminal input call requires fresh approval for that job and exact
payload, even if those bytes were approved for an earlier prompt.
No semantic judgment authorizes a command or accepts a prompt. Without the
guardrail, this package alone is **not** an approval mechanism.

## Optional Jev attention

`watch: "the server is ready to accept requests"` adds a one-shot semantic
attention hint. No watch means no TypeSafe request. The existing shared client
sends only the condition, id and last 4,000 log characters, with its normal secret
redaction, transport, usage accounting and decision ledger.

Independent jobs batch into one request, at most once per five seconds and thirty
requests per session, with a five-second deadline. A probability of at least
0.85 alerts once; uncertain/missing answers stay unknown. Changed output,
completed/forgotten jobs invalidate stale answers. Any typed input or human
takeover cancels automatic semantic attention for that job, including in-flight answers. Service
failure disables watches with a warning; jobs, logs and exit notices still work.
This threshold is a conservative attention policy, **not an evaluated accuracy
claim**. Model hints are untrusted inference, never verification.

## Verification integration

Done-gate and diagnosis-checkpoint consume completed results through
`terminal_read`, not launch success or model interpretations of log text.
Only actual exit status from an untouched, agent-owned job in the current cwd,
with matching known start/end/current Git identities, counts. Typed input or
takeover invalidates evidence. A non-null `cleanup_error` also makes process
cleanup unverified and cannot count as a passing check. Re-reading a consumed result cannot verify a new
edit or count another failed attempt; a previous user input's job cannot clear
the current done-gate. Interrupted, masked, stale and revision-unknown checks
remain unverified. Remote CI evidence still uses the existing hosted-check path.

Run `node --test packages/jobs/test/*.test.mjs` for behavior checks and
`node .pi/verify/jobs.mjs` for isolated real-Pi TUI/PTY acceptance.
`bash .pi/verify/jobs-linux.sh` checks GNU PTY utility primitives in an already-cached
Docker image (no downloads); it is not a full Linux Node/Pi integration check.

Verification limits: the scripted Jev fixture proves transport/redaction, not watch
accuracy. LCOV covers the shared adapter and `.mjs` logic, not TypeScript
entrypoints or native takeover; the latter has the separate real-TUI drive.
CRAP reports those coverage gaps, and Deadwood flags this repo's intentionally
host-provided imports; Knip/Fallow remain the repository gates. Local checks are
not hosted CI evidence.
