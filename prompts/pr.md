---
description: Review a GitHub PR including CI status and review comments
argument-hint: "<PR-URL-or-number>"
---
Review PR $1 end to end: diff correctness, logic bugs, security, error handling, and test coverage. Also check CI status and failures (`gh pr checks $1` / `gh run view`), and read existing review comments for unresolved threads (`gh pr view $1 --comments`). Report findings as path:line with severity. Do not edit files.
