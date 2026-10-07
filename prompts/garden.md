---
description: Queue agent shortcuts as environment fixes instead of patching one-offs
argument-hint: "[path or git ref]"
---

Act like a quality supervisor: sample the code, do not review all of it, and improve the environment rather than a single output.

1. Scope: $ARGUMENTS if given (a path or git ref), otherwise `git diff HEAD~10 --name-only` plus the uncommitted diff. List the files in scope.
2. Read those files looking for agent shortcuts: tautological tests that assert the implementation back to itself, swallowed errors, copy-paste with small edits, dead code, `any`/unsafe casts, lint suppressions with no reason, stale comments, magic numbers, and feature logic dumped into a shared god file.
3. Read `.pi/garden.md` if it exists. Do not duplicate an entry: if the same pattern appears in a new location, add the location to the existing entry and bump its count.
4. Append entries under a `## YYYY-MM-DD` heading — `path:line — pattern`, one line on why it matters, and the cheapest guard that would prevent it: lint rule, type constraint, test, AGENTS.md line, or guardrail policy.
5. Do not fix anything you find. This is a queue, not a work order.
6. When an entry reaches 3 occurrences, promote it: draft the exact lint rule or AGENTS.md line and ask me to confirm before editing any config.
7. Report what you appended, which entries repeated, and the top promotion candidate. Offer to add `.pi/garden.md` to `.gitignore` if I want the queue to stay local.
