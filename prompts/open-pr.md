---
description: Open a ready PR from small ordered commits with a briefing-style body
argument-hint: "[base]"
---
Open a pull request for the work authorized in this task against ${1:-the default branch}.

1. Confirm the branch holds only this change. Order commits so each one stands alone; a failing repro lands before its fix.
2. Run the repo's required checks on the committed head. Do not open a PR on a red head.
3. Title: `type(scope): subject`, naming a real symbol when one carries the change.
4. Body, under 40 lines, these `##` headings in this order, empty ones dropped: `Why`, `What changed`, `Scope`, `Tradeoffs` (only rejected alternatives a reviewer would ask about), `Blast Radius`, `Verification` (the command and the observed result, not "tests pass"). Evidence logs and long tables go in a comment or file, linked from the body.
5. Push the branch with `git push -u origin HEAD`; never force-push. Write the body to a file and pass it with `gh pr create --body-file`; never build it inside a quoted shell string. Pass `--base` when a base was given. Open it ready, not draft.
6. Report the URL, then call `watch_pr` once. Opening a PR does not start a babysit and is not permission to merge.
