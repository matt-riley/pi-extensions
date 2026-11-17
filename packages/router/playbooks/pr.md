## Playbook: open a pull request

Copy these steps into your todo list before task-specific items; a step you skip stays with `skip: <reason>`.

1. Confirm the branch holds only this change. Order commits so each stands alone; a failing repro lands before its fix.
2. Run the repo's required checks on the committed head. Do not open a PR on a red head.
3. Title it `type(scope): subject`, naming a real symbol when one carries the change.
4. Body under 40 lines: Why, What changed, Scope, Tradeoffs, Blast Radius, Verification (the command and its observed result). Drop empty headings.
5. Write the body to a file and pass it with `gh pr create --body-file`. Open it ready, not draft.
6. Report the URL and read `watch_pr` once. Opening a PR is not permission to merge.
