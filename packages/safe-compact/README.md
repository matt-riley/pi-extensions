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
4. **Route.** Code applies hard rules: user constraints and the session's first user message are
   always verbatim, and uncertain or load-bearing content is never dropped outright. Open problems are kept verbatim when there is
   room. Tool output is excerpted unless it is an error, because it can be re-run or re-read.
5. **Select.** Jev picks decision sentences and the relevant line windows of large file reads.
   Output is copied spans and `path:start-end` pointers, never generated prose.
6. **Fit.** The handoff ends with a fixed line code writes, never the model: the verbatim
   pre-compaction transcript and how to search it, because a handoff is a note plus a way to check
   it. (Measured on cross-session capsules, one search of the transcript a capsule replaced was
   worth 20–33 points of recall — more than any wording of the note.) The handoff aims for 25% of
   what it replaces, at most 12K tokens. Over that, the
   least load-bearing entries are cut first: verbatim copies become excerpts, then plain context
   excerpts are dropped. Open problems are cut last; user constraints, the session's first user message and
   verification-forced copies never, so those alone can carry a handoff past the target.
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
   so pi's native summary runs instead.

   Before the handoff that names it, the branch about to be replaced is snapshotted to
   `~/.pi/agent/safe-compact/<timestamp>.jsonl` (one JSON object per entry, oldest first;
   `PI_SAFE_COMPACT_DIR` overrides the directory, the newest 50 are kept). If the handoff is
   rejected, or pi's own compaction is what ships, the file is deleted again: the previous
   behaviour left transcript dumps inside the working tree, one `git add -A` from being
   committed, with nothing pointing at them.

Jev answers are memoized per session by their exact input, so a retry, or the next compaction over
an overlapping span, pays only for messages it has not judged yet.

## What a compaction costs

Every judgment is one request, so a 58-segment span is 58 scoring requests plus one per verification
item. Scoring and verification always run to completion; the selections that turn a big tool result
into a pointer instead of a copy are an enrichment, and stop being asked for 20 seconds in. If the
handoff has still not finished at 90 seconds, or a phase would start after the clock is up, it is
refused and pi's native summary runs — a half-judged handoff is never shipped. The compaction
details carry `judging.requests` and `judging.failed`, so a handoff missing a lost judgment does not
read as a clean one.

**Batching those requests was tried and rejected.** Measured on one real 58-segment span, against
Jev's own repeat of the identical request as the control:

| run | requests | judgments changed |
| --- | --- | --- |
| same request, both times (control) | 58 + 58 | 0 of 58 |
| segment scoring, 8 segments per request | 58 → 8 | 6 of 58 |
| coverage, same request twice (control) | 58 + 58 | 2 of 58 |
| coverage, 8 checks per request | 58 → 18 | 7 of 58 |

Worse than the drift was its direction: the segments that flipped to `keep_verbatim` carried 21k
tokens of verbatim copy where the unbatched run carried 0.6k, and verbatim copies are what push a
handoff past its target. The eval script below reports calls and seconds, so a future attempt can
be measured the same way.

`node scripts/safe-compact-eval.mjs` replays real sessions from `~/.pi/agent/sessions` to the hard
threshold and reports success, handoff size, tool-output share, and the calls and seconds of the
first attempt and a retry. It makes real TypeSafe calls.

## Surface

- Tools: `self_compact(note?)` (note carried verbatim), `view_context()`.
- Commands: `/safe-compact [note]`, `/safe-compact-plan` (dry run, shows the handoff),
  `/safe-compact-info`.
- Flags: `--compact-soft-at <pct>`, `--compact-at <pct>`.
- Needs `TYPESAFE_API_KEY` (shared with `pi-typesafe`); without it, native compaction is used.
- `PI_SAFE_COMPACT_DIR` — where pre-compaction transcripts are written
  (default `~/.pi/agent/safe-compact`). Keep it out of your repositories.

## Files

`segment.mjs` (deterministic splitting), `judge.mjs` (every Jev question), `plan.mjs` (routing,
assembly, verification), `index.ts` (pi wiring).
