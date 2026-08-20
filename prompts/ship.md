---
description: Run checks, commit, and push
argument-hint: "[message]"
---
Ship it: run the repo's check/test commands first, then stage everything, commit with a Conventional Commit message (use $@ if given), and push to origin. If checks fail, fix and re-run — do not ship red. Report hash, branch, and push result.
