---
description: Review the current change for needless complexity and apply behavior-preserving simplifications
argument-hint: "[scope]"
---
Simplify the current change. Scope is $@ when given (named paths, or a base ref for the diff), otherwise the diff from the merge base with the default branch through the working tree. `/review` finds defects without editing; `/refactor` reshapes one target by interface; `/simplify` hunts needless complexity across the change and applies safe cuts. Needs subagents on.

Use the `swarm` skill (find it with `skill_select`, then read its `SKILL.md`) to fan four slices in one turn. Each child is read-only and reports proposals; the parent alone edits.

| Slice | Child brief |
| --- | --- |
| `dead-slop` | On the same scope: `git diff` from the merge base, then read and grep touched files only. Report dead or unused code and added lines that look like failures turned into normal-looking values, comments that repeat the next line, `as any` and other type escapes, defaults or guards for cases nobody described, deeply nested logic, single-implementation interfaces and forwarding wrappers. |
| `overengineering` | Call `lint_change` on that scope and report only `overengineered` and `scope_creep` findings (pass `task` when you have one). |
| `reuse` | Search the whole repository for an existing helper, utility or pattern this change duplicates. Name the canonical definition and what to call instead. |
| `altitude` | Find logic at the wrong layer: policy in an entrypoint that belongs in a plain module, cross-package copies that belong in `shared/`, UI or extension code owning domain rules, or callers re-orchestrating what a neighbor already exposes. |

After `swarm_report`, merge the slices. Apply only simplifications that preserve behavior: delete dead code, inline thin wrappers, call existing helpers, or move code without changing exports or semantics. Skip anything that needs a behavioral judgment you cannot justify from the diff and tests.

Run the repository's required tests after applying fixes. Revert any fix that fails a test. Finish with a short plain-text list of what was applied and what was skipped and why. No JSON and no structured findings schema.