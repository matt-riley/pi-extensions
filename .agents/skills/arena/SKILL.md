---
name: arena
description: Run the same task as several isolated candidates on different models, pick a base by rubric, and graft the best parts of the others. Use for "arena this", competing designs or implementations, or when one attempt would lock in the wrong shape. Needs subagents on.
---

# Arena

Skip this for mechanical work whose shape is already settled.

1. **Frame.** Name the artifact. Write 3 to 6 gradeable criteria. The rubric is for you
   and the judge. Candidates see only the task.
2. **Fan out.** `review_panel` for seats. One `worker` per seat in a single turn, each
   with `isolation: "worktree"` and the same brief, asking for the artifact plus a short
   rationale naming what it considered and rejected. For a design with no code, use
   `oracle` and no worktree. A candidate that returns nothing is a dropout: continue and
   say so.
3. **Cross-judge.** Spawn one `oracle` on the panel's `judge` model with the rubric and
   the candidates labelled A, B, C by worktree path. Never give it model names. It scores
   each criterion and recommends a base. With no judge, say so and judge alone.
4. **Pick.** Read every candidate end to end yourself and score it per criterion. If you
   and the judge disagree, read both rationales before deciding. Prefer the base a
   maintainer can extend without breaking invariants; on a tie, the smaller API.
5. **Graft.** Port one or two things from each loser by hand so the result keeps one
   mental model. If candidates converge, ship the consensus and skip grafting. If they
   diverge wildly, the frame was underspecified: reframe and rerun.
6. **Verify** the synthesis with the repo's checks and `.pi/verify`. A failure the arena
   missed means step 1 was wrong or a graft was missed.

## Report

The base and why, the judge's verdict, each graft with its source, what was rejected,
dropouts, the panel's notes, and the verification result.
