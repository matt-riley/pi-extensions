## Playbook: multi-phase plan

Copy these steps into your todo list before task-specific items; a step you skip stays with `skip: <reason>`.

1. Skip the plan for a change of one or two files: do the work instead and say so.
2. Read the code each phase touches. List the open forks and settle each with a small prototype, not a guess.
3. Draw the dependency graph: which changes need which, and which can land in parallel.
4. One PR per change. For each, give a unit check, a live check on the real surface and, where speed matters, a perf number.
5. Put the riskiest change first, so the plan fails early if it is going to.
6. Stop at the plan. Present it for approval and do not start the first change.
