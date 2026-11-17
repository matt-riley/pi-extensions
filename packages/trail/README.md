# pi-trail: a decision trail with checked evidence

A long or unattended run leaves a lot of transcript and little record of why.
`decision_log` keeps the record: one TSV row per decision that shaped the work,
each with a pointer to its evidence, checked when it is written. `/trail` audits
the log against the conversation and asks another model family to review it.

## `decision_log` (deferred tool)

| Field | What goes in it |
| --- | --- |
| `phase` | Stage of the task: `plan`, `fix`, `verify`, ... |
| `decision` | What was chosen or done, one line |
| `why` | What triggered or justified it |
| `evidence` | A pointer, never a paragraph: commit SHA, `path:line`, command, PR number, artifact path |
| `result` | `tests green`, `reverted`, `INCONCLUSIVE`, `open`, ... |

Log forks chosen, units finished with their check result, pivots and reverts
with what triggered them, and blockers. Not every action.

- Rows go to `.pi/runs/decisions.tsv` in the session's cwd as
  `ts, phase, decision, why, evidence, result`. The file is append-only: a
  wrong row is superseded by a new one, never edited.
- When a session first adds to a log that already exists, a `start` row with
  the session id marks where its rows begin.
- **Evidence is checked at write time.** Paths named in it must exist
  (the stale-path check subagents use for child tasks), `path:line` must name a
  real line, and anything that looks like a commit SHA must pass
  `git cat-file -e <sha>^{commit}`. The row is still written when a check
  fails; the tool's answer says what does not resolve, so it can be corrected
  with a superseding row. Evidence with no path or SHA is reported as
  unverified. Commands and PR numbers are not run or fetched.
- `.pi/runs/` carries a `.gitignore` of `*`, so the trail stays out of git.

The tool is deferred: it is found through tool search rather than sitting in
every prompt. Its annotations are local and not read-only, because it writes a
file and runs `git`.

## `/trail` (prompt)

`prompts/trail.md` reads the rows this session wrote, checks each against the
conversation and its evidence, adds rows for unlogged forks and pivots, then,
with subagents on, has one `oracle` subagent on another model family review the
trail. It ends with an **Attention** section that names the reviewing model, or
says none was available.
