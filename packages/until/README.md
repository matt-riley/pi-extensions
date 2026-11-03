# pi-until — keep going until the predicate passes

Give the agent a finish line it can check: a shell command that exits 0. If the
check fails when the agent tries to stop, its output sends the agent back to
work. The loop still ends at its check limit, on error, or when you cancel it.

```
/until [--max N] <command> [-- task]
/until stop
/until            # status
```

For example, keep working on a test failure, or wait for a PR's checks:

```
/until npm test -- fix the flaky date test
/until --max 5 gh pr checks 42
```

## Behaviour

- Starting a loop sends a kickoff message (the task, or "make `<command>` exit 0")
  and runs the agent.
- Every time the run is about to settle, the command runs via `sh -c` in the
  session's cwd (10 minute timeout).
  - exit 0 → loop ends, notification.
  - non-zero → the last 40 lines of output go back to the agent as a message,
    with the rule: *a plateau is not a stop; never relax the predicate*. The
    agent continues.
  - after `--max` checks (default 20) it gives up and says so.
- An aborted (Esc) or errored run ends the loop instead of fighting you.
- One TSV row per check (`ts, iteration, exit, summary`) is appended to
  `.pi/runs/until-<timestamp>.tsv` in the cwd, so a run you walked away from
  leaves a trail.

The first ` -- ` separates the command from the task, so a command that itself
needs `--` (e.g. `npm test -- --grep x`) belongs in a script or `sh -c '…'`.

The command is yours, typed at the prompt. The model never supplies it.

## How

`agent_before_settle` is pi's final actionable boundary: a handler can append a
`custom_message` draft (the model reads it as a user message) and return
`continue: true` for one more request. The loop re-arms itself at every settle,
so no timers or watchers are involved.
