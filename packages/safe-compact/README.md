# pi-safe-compact

Safe self-compaction for pi, with Jev making the judgment calls. Inspired by
[self-compact-pi-agent](https://github.com/disler/self-compact-pi-agent), but the
handoff is assembled and verified rather than trusted to one note.

## How it works

1. **Trigger (hybrid).** Below `--compact-soft-at` (default 50%) nothing happens. Between soft and
   `--compact-at` (default 70%, max 90%), Jev judges each turn boundary (mid-change? debugging?
   just finished?) and compaction runs at the first clean one. At the hard threshold, or when the
   agent calls `self_compact`, it runs regardless.
   Percentages are of the context window capped at 300K tokens, so a 1M-token model compacts where
   a 272K one does instead of re-sending a half-million-token prefix every turn.
2. **Commit at the boundary.** The handoff is appended as a compaction entry through pi's `turn_end`
   boundary, so the run is never aborted: a mid-task agent continues from the compacted context,
   and a finished turn stays finished. `ctx.compact()` (which aborts the current operation) is
   reserved for the manual `/safe-compact` command.
3. **Score.** Each older message is scored by Jev: load-bearing, user constraint, decision,
   unresolved problem, recoverable, plus a keep/point/excerpt/drop choice.
4. **Route.** Code applies hard rules: user constraints are always verbatim, and uncertain or
   load-bearing content is never dropped outright. Open problems are kept verbatim when there is
   room. Tool output is excerpted unless it is an error, because it can be re-run or re-read.
5. **Select.** Jev picks decision sentences and the relevant line windows of large file reads.
   Output is copied spans and `path:start-end` pointers, never generated prose.
6. **Fit.** The handoff aims for 25% of what it replaces, at most 12K tokens. Over that, the
   least load-bearing entries are cut first: verbatim copies become excerpts, then plain context
   excerpts are dropped. Open problems are cut last; user constraints and verification-forced
   copies never, so those alone can carry a handoff past the target.
7. **Verify.** Jev checks that entries which restate their source (excerpts and decisions) are
   faithful, and that important segments are still represented. A gap re-includes that segment
   verbatim and the handoff is rebuilt, except tool output that can be re-read or re-run, which comes
   back as a pointer (`path:lines`, or the command with "re-run only if safe"); a verbatim copy is taken as-is. The check runs once —
   a re-ask against the rebuilt handoff can only flip a settled answer into forcing another
   segment, never uncover a gap the first pass missed.
8. **Commit or fall back.** On the boundary path a handoff that cannot be verified or would still
   be 60% of the summarized span is not committed. The next attempt waits until the context has
   grown another 10K tokens, so a rejection is not rebuilt at every turn; a rejection at the hard
   threshold runs pi's own compaction once the run settles, never mid-run. A history longer than one handoff can
   verify is summarized in capped chunks over successive boundaries, so long sessions still
   compact. The size check counts both the replaced messages and the previous summary; rejected
   handoffs report the specific reason (including size estimates) without relaxing verification.
   Inside `session_before_compact` (manual, threshold, overflow), a failure returns nothing
   so pi's native summary runs instead. Before every compaction the full branch is snapshotted to
   `.pi/safe-compact/<timestamp>.jsonl`.

Jev answers are memoized per session by their exact input, so a retry, or the next compaction over
an overlapping span, pays only for messages it has not judged yet.

`node scripts/safe-compact-eval.mjs` replays real sessions from `~/.pi/agent/sessions` to the hard
threshold and reports success, handoff size, tool-output share, and the calls and seconds of the
first attempt and a retry. It makes real TypeSafe calls.

## Surface

- Tools: `self_compact(note?)` (note carried verbatim), `view_context()`.
- Commands: `/safe-compact [note]`, `/safe-compact-plan` (dry run, shows the handoff),
  `/safe-compact-info`.
- Flags: `--compact-soft-at <pct>`, `--compact-at <pct>`.
- Needs `TYPESAFE_API_KEY` (shared with `pi-typesafe`); without it, native compaction is used.

## Files

`segment.mjs` (deterministic splitting), `judge.mjs` (every Jev question), `plan.mjs` (routing,
assembly, verification), `index.ts` (pi wiring).
