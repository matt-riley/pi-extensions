---
description: Defect-first review of staged (or unstaged) changes
---
Review `git diff --cached`, falling back to `git diff` if nothing is staged. Return every actionable finding as `path:line` with severity, covering logic bugs, security issues, error-handling gaps, and edge cases. Do not edit files.
