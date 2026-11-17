---
description: Find what a change could break outside the diff and prove the one fact it is safe because of
argument-hint: "[ref or path]"
---
Work out the blast radius of ${1:-the current diff}.

1. Read the change, including what it now does differently that the diff does not spell out. Run `blast_radius` for the callers; that list is the start, not the answer.
2. Find the one fact the change is safe because of ("this call only drops already-dead entries"). Spend the time here, not on a long list of maybes.
3. Look where grep stops: the pinned version and source of any library you call, ordering and teardown, serialized formats, config and flags, other languages reading the same bytes, code several hops downstream.
4. Prove the fact. Write a small script or test that calls the real code and fails loudly if you are wrong, run it, and paste the output. For each fact say how far it got: asserted, pointed at a line, walked step by step, ran it, reproduced in the running app.
5. Report: what the change does; the safety fact and its proof, or "unproven"; risks with `path:line`, likelihood, cost and how to check; what you checked and cleared; and the cheapest test that would catch the real bug.

Do not edit the code under review. Scratch scripts go outside the tree and are deleted after.
