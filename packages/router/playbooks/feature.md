## Playbook: feature

Copy these steps into your todo list before task-specific items; a step you skip stays with `skip: <reason>`.

1. Read the code it touches and trace the real flow end to end. Reuse before you write.
2. Name the data shape first, and the structure that holds it (typed model, table, state machine) over scattered conditionals.
3. Climb the lazy ladder: does it need building, does it exist here, stdlib, platform, installed dep, one line.
4. Build in small units that each end in a check; run it before starting the next.
5. Verify the behaviour on the real surface (run the CLI, hit the endpoint, drive the UI), not just "it compiles". Use `.pi/verify` if the repo has one.
6. Report what you built, what you chose and why, what you skipped, and the evidence it works.
