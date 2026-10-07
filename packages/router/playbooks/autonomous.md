## Playbook: autonomous run

Copy these steps into your todo list before task-specific items; a step you skip stays with `skip: <reason>`.

1. Before the first change, write the exit condition as a checkable predicate (a command that exits 0, all N PRs merged, the repro green).
2. Each iteration: the smallest change the evidence justifies, check it against the predicate, keep it if it moved, revert it if it did not.
3. Do not stop to ask about reversible work. Fix side problems (flaky checks, broken tooling) yourself and return to the predicate.
4. Pause only for irreversible actions: force-push to shared branches, deploys, data deletion, messages to other people.
5. A plateau is not a stop: change approach. Never relax the predicate to declare victory; surface a real dead end instead.
6. Keep one line per iteration (what changed, did the predicate move) and finish with the predicate's final state.
