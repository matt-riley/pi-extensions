# pi-drift — notice edits made behind the agent's back

Files change under a session between its runs: an editor, another terminal, a
`git checkout`. The agent's earlier reads are then stale, and it can overwrite
your change from memory. This extension tells it.

There is nothing to configure after you [install the collection](../../README.md#install).

## What it does

1. When a run settles, it fingerprints the working tree (the same fingerprint
   done-gate, jobs and subagents use) and remembers a content hash for each
   changed or untracked file.
2. When your next prompt arrives, it fingerprints again. If the tree differs, one
   short prompt section, `drift`, names the paths that changed outside the
   session (up to 12, then a count), says if HEAD moved, and asks the agent to
   re-read them before relying on earlier reads or edits.

A change is reported once. Only your own prompts are checked, not injected
follow-ups. Nothing is blocked and nothing is shown in the transcript.

## What it ignores

- **The session's own work.** Edits made during a run are in the baseline taken
  when the run settles. A run that was aborted drops the baseline, so its
  half-done edits are never blamed on someone else.
- **Subagents and jobs it started.** While a subagent (from the
  `subagents:*` events; a child only starts once the writer queue lets it) or a
  background job (from the jobs tool results) is still running, its writes
  cannot be told from anyone else's, so the check pauses instead of blaming it.
  A job that never finishes, such as a watcher, pauses it for the session.
- **Ignored paths.** Git's own ignore rules, plus `node_modules` and
  `.pi/cache`, the same paths code-search always leaves out.

## Limits

- Git repositories only. Outside one, or when git cannot produce a fingerprint
  (a very large untracked file), it stays silent.
- Hashes cover the first 200 changed files, each up to 1 MB; past that the list
  says it may be incomplete.
- A change that is reverted before the next prompt is not a drift.
- No model call and no network.

The section appears in safe-compact's `view_context` prompt-size view, because
drift is registered before safe-compact in the root manifest (a test pins that
order).
