# pi-safe-compact

Safe self-compaction for pi, with Jev making the judgment calls. Inspired by
[self-compact-pi-agent](https://github.com/disler/self-compact-pi-agent), but the
handoff is assembled and verified rather than trusted to one note.

## How it works

1. **Trigger (hybrid).** Below `--compact-soft-at` (default 50%) nothing happens. Between soft and
   `--compact-at` (default 70%, max 90%), Jev judges each turn boundary (mid-change? debugging?
   just finished?) and compaction runs at the first clean one. At the hard threshold, or when the
   agent calls `self_compact`, it runs regardless.
2. **Commit at the boundary.** The handoff is appended as a compaction entry through pi's `turn_end`
   boundary, so the run is never aborted: a mid-task agent continues from the compacted context,
   and a finished turn stays finished. `ctx.compact()` (which aborts the current operation) is
   reserved for the manual `/safe-compact` command.
3. **Score.** Each older message is scored by Jev: load-bearing, user constraint, decision,
   unresolved problem, recoverable, plus a keep/point/excerpt/drop choice.
4. **Route.** Code applies hard rules (user constraints and unresolved errors are always verbatim;
   uncertain or load-bearing content is never dropped).
5. **Select.** Jev picks decision sentences and the relevant line windows of large file reads.
   Output is copied spans and `path:start-end` pointers, never generated prose.
6. **Verify.** Jev checks that lossy entries are faithful and that important segments are still
   represented. A gap re-includes that segment verbatim and rebuilds (up to 3 rounds).
7. **Commit or fall back.** On the boundary path a handoff that cannot be verified or would not
   meaningfully shrink the summarized span is simply not committed: the context stays as it is and
   pi's native threshold compaction remains the backstop. Inside `session_before_compact` (manual,
   threshold, overflow), a failure returns nothing so pi's native summary runs instead. Before every
   compaction the full branch is snapshotted to `.pi/safe-compact/<timestamp>.jsonl`.

## Surface

- Tools: `self_compact(note?)` (note carried verbatim), `view_context()`.
- Commands: `/safe-compact [note]`, `/safe-compact-plan` (dry run, shows the handoff),
  `/safe-compact-info`.
- Flags: `--compact-soft-at <pct>`, `--compact-at <pct>`.
- Needs `TYPESAFE_API_KEY` (shared with `pi-typesafe`); without it, native compaction is used.

## Files

`segment.mjs` (deterministic splitting), `judge.mjs` (every Jev question), `plan.mjs` (routing,
assembly, verification), `index.ts` (pi wiring).
