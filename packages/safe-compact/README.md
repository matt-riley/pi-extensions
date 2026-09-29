# pi-safe-compact

Safe self-compaction for pi, with Jev making the judgment calls. Inspired by
[self-compact-pi-agent](https://github.com/disler/self-compact-pi-agent), but the
handoff is assembled and verified rather than trusted to one note.

## How it works

1. **Trigger (hybrid).** Below `--compact-soft-at` (default 50%) nothing happens. Between soft and
   `--compact-at` (default 70%, max 90%), Jev judges each turn boundary (mid-change? debugging?
   just finished?) and compaction runs at the first clean one. At the hard threshold, or when the
   agent calls `self_compact`, it runs regardless.
2. **Score.** Each older message is scored by Jev: load-bearing, user constraint, decision,
   unresolved problem, dead end, recoverable, plus a keep/point/excerpt/drop choice.
3. **Route.** Code applies hard rules (user constraints and unresolved errors are always verbatim;
   uncertain or load-bearing content is never dropped).
4. **Select.** Jev picks decision sentences and the relevant line windows of large file reads.
   Output is copied spans and `path:start-end` pointers, never generated prose.
5. **Verify.** Jev checks that lossy entries are faithful and that important segments are still
   represented. A gap re-includes that segment verbatim and rebuilds (up to 3 rounds).
6. **Commit or fall back.** If Jev is unreachable, a gap cannot be closed, or the handoff is not
   meaningfully smaller, pi's native compaction runs instead. Before every compaction the full
   branch is snapshotted to `.pi/safe-compact/<timestamp>.jsonl`.

## Surface

- Tools: `self_compact(note?)` (note carried verbatim), `view_context()`.
- Commands: `/safe-compact [note]`, `/safe-compact-plan` (dry run, shows the handoff),
  `/safe-compact-info`.
- Flags: `--compact-soft-at <pct>`, `--compact-at <pct>`.
- Needs `TYPESAFE_API_KEY` (shared with `pi-typesafe`); without it, native compaction is used.

## Files

`segment.mjs` (deterministic splitting), `judge.mjs` (every Jev question), `plan.mjs` (routing,
assembly, verification), `index.ts` (pi wiring).
