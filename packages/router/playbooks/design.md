## Playbook: figure it out

Copy these steps into your todo list before task-specific items; a step you skip stays with `skip: <reason>`.

1. Write the done predicate so a run can falsify it, and quantify the scope (which inputs, how many, how fast).
2. Build the harness before the work: the command that checks the predicate, run once and red.
3. Attack the riskiest unknown first; if it fails, the rest of the plan changes.
4. Every unit of work is an experiment: a hypothesis, the run that tests it, and what the result means.
5. Record each claim as VERIFIED (a run showed it), NOT VERIFIED (a run refuted it) or INCONCLUSIVE (the run could not tell).
6. Report the predicate's final state, the verdict per claim, and what is still open.
