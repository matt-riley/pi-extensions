---
description: Commit all changes on this branch and push, Conventional Commits style
argument-hint: "[message]"
---
Stage every change in the working tree, commit it on the current branch with a Conventional Commit message, and push to upstream (main when none is set). Run the commit — do not print an example.

- If `git status --short` is empty, say "nothing to commit" and stop.
- `git add -A`, then derive the message from `git diff --cached`.
- Subject: `type(scope): subject` — imperative, lowercase, no trailing period. Add a short body only when the diff needs explanation. If the user supplied text, use it as the subject (or subject + body).
- `git commit -m` the message; let hooks run.
- `git push` to origin (current branch, or main).

Report the commit hash, branch, and push result.

$@
