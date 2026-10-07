---
description: Triage open GitHub issues against main — reproduce, classify, then dispatch
argument-hint: "[issue numbers…]"
---

Triage the open issues in this repo. Change nothing on GitHub.

1. Confirm this is a GitHub repo: `gh repo view --json nameWithOwner`. If not, stop.
2. List candidates: `gh issue list --state open --limit 100 --json number,title,author,labels,createdAt,body,url`. If $ARGUMENTS names numbers, triage only those. Skip bots and dependency churn — authors ending in `[bot]` or named renovate/dependabot, and `dependencies`-style labels.
3. Decide whether each issue is still valid from the code, not the issue text alone:
   - Find the code path it names with code_search / find_definition.
   - Look for a fix already merged: `git log --oneline --since=<createdAt> -- <paths>` and `gh pr list --state merged --search "<number>"`. If one exists, read it and state whether it fully addresses the report.
   - Otherwise try to reproduce with the smallest relevant command or test. Run it as the tree stands; if the working tree is dirty, say so and do not switch, stash, or reset.
4. Classify each issue: two-way door (local, revertible) or one-way door (data migration, auth, money, public API, anything hard to walk back). One-way doors are never delegated or auto-fixed.
5. Report a table: issue · verdict (valid / fixed by #N / needs info / invalid) · evidence (command + result, or `path:line`) · door · recommended next action. Add one line per issue on what "done" looks like.
6. Stop there and wait for approval. If I approve and `/subagents` is on, dispatch one `worker` per valid two-way-door issue with a fully-specified task — but keep reports sharing a root cause in a single task instead of one fix per issue.
7. Never close, comment, label, or reassign an issue without an explicit instruction.
