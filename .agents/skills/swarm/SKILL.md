---
name: swarm
description: Split one check or job across parallel children under a PASS / ISSUES / BLOCKED contract, where a missing or malformed result is a gap and never a pass. Use for "swarm this", fanning a check out over many files or targets, or racing several attempts at one task. Needs subagents on.
---

# Swarm

1. **Done predicate.** State in one sentence what must be true for the whole job to
   pass. Record the commit under check with `git rev-parse HEAD`, and say when the tree
   is dirty.
2. **Partition or race.** Before spawning, either split the job into slices that do not
   overlap and mark which are required, or declare a race rule: `first pass`, `rank all`
   or `best-of`. Give each writer `isolation: "worktree"`.
3. **Brief.** Every child gets the predicate, its slice, and this contract: the first
   line of the reply is `PASS`, `ISSUES` or `BLOCKED`, and the reply names the commit SHA
   it checked. Spawn every slice in one turn; four run at once and the rest queue.
4. **Aggregate.** Call `swarm_report` with each result's `id` and slice, and
   `expect_sha` set to the commit. Do not tally the results by reading them yourself.
5. **Respawn each gap once** with the same brief and the gap's reason. A second gap
   stays a gap.

## Report

One table of slice, verdict and reason, then the overall verdict from `swarm_report`,
the commit checked, and every remaining gap. `INCOMPLETE` is not a pass: never round
it up. For a race, add the rule, the winner and why.
