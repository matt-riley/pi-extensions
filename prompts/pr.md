---
description: Review a GitHub PR including CI status and review comments
argument-hint: "<PR-URL-or-number>"
---
Review PR $1 with the review-agent skill (fetch its diff first via `gh pr diff $1`, or `gh pr checkout`). Additionally check CI status and failures (`gh pr checks $1` / `gh run view`) and read existing review comments for unresolved threads (`gh pr view $1 --comments`). Report findings as path:line with severity. Do not edit files.
