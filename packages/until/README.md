# pi-until: keep going until the predicate passes

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
  - exit 0: the loop ends, with a notification.
  - non-zero: the last 40 lines of output go back to the agent as a message,
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

## /climb: a metric loop

`/until` asks "is it green". `/climb` asks "is the number better", one change
per measurement.

```
/climb [--max N] [--min N] [--runs N] [--higher|--lower] --target <number> --gate "<cmd>" <metric-cmd> [-- task]
/climb stop
/climb            # status
```

```
/climb --target 25 --gate "npm test" node bench/parse.mjs -- make parsing faster
```

- `<metric-cmd>` prints one JSON line, the counter contract `measure_command`
  uses: `{"value": 41.2, "completed": 100, "cached": 0}`. Zero or cached work,
  a missing value, or a non-zero exit is not a sample.
- `--gate` is the regression check and must exit 0 (`npm test`).
- `--runs` (3 to 10, default 3) samples per measurement; `--lower` (default) or
  `--higher` says which way is better; `--max` (default 20) caps attempts;
  `--min` (default 1) is the attempt floor before a met target ends the run.

Behaviour:

- **Baseline first.** Starting the loop runs the gate and the metric on the
  untouched tree. A red gate or a failed measurement starts nothing; a baseline
  that already meets the target ends at once.
- **One attempt per settle.** Each time the run is about to settle, the gate
  runs, then the metric `--runs` times. The attempt is kept only when the gate
  passes and its whole range clears the best accepted range (for `--lower`, its
  maximum is below the best minimum). Otherwise it is rejected.
- **The agent reverts; the loop checks.** On a rejection the agent is told to
  revert in full and stop. The next settle compares the tree's content with the
  last accepted state and counts no attempt until they match. The comparison is
  a git tree id built in a throwaway index from every non-ignored file, so it
  does not change when the agent commits an accepted state, and it never
  touches your index, refs or files.
- **Never commits.** A kept attempt is reported with its tree id; committing is
  left to the agent under whatever you authorised.
- A settle with nothing changed, or a revert that does not match, counts no
  attempt; three in a row end the loop. An aborted or errored run ends it too.
- One TSV row per attempt and per revert check (`ts, iteration, hypothesis,
  before, after, range, gate, verdict`) is appended to
  `.pi/runs/climb-<timestamp>.tsv`. The hypothesis is the agent's
  `Hypothesis:` line, or the first line of its last message.

Both commands are yours; the model never supplies them. `/climb` and `/until`
do not run at the same time.

`.pi/runs/` gets a `.gitignore` of `*` when either loop creates it, so the logs
stay out of git and out of working-tree fingerprints.

## How

`agent_before_settle` is pi's final actionable boundary: a handler can append a
`custom_message` draft (the model reads it as a user message) and return
`continue: true` for one more request. The loop re-arms itself at every settle,
so no timers or watchers are involved.
