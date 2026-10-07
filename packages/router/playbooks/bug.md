## Playbook: bug fix

Copy these steps into your todo list before task-specific items; a step you skip stays with `skip: <reason>`.

1. Build the feedback loop first: one command (test, curl, CLI fixture, script) that you have run and that goes red on the user's exact symptom. No hypotheses before it exists.
2. Minimise the repro until every remaining part is load-bearing.
3. Write 3–5 falsifiable hypotheses ("if X, then changing Y makes it go away") and test them one variable at a time. Tag debug logs `[DEBUG-xxxx]`.
4. Grep every caller of what you change; fix the root cause once, where they all route through.
5. Regression test at a seam that reproduces the real pattern, failing before the fix. No correct seam is a finding: say so.
6. Re-run the original loop, grep out the `[DEBUG-` tags, and report: symptom, root cause, fix, red-then-green output.
