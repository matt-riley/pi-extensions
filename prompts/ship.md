---
description: Run checks, commit atomically, and push
argument-hint: "[message]"
---
Ship it: run the repo's check/test commands first. If checks fail, fix and re-run — do not ship red. Then commit the working tree as atomic Conventional Commits: group unrelated changes into separate commits ordered by dependency (source above tests/docs/config), `git add` only the specific paths per commit (never `git add -A`), use `type(scope): subject` with $@ as the headline subject if given, and push once to origin. Report each commit hash with a one-line summary, the branch, and the push result.
