---
description: Verify changed behavior, commit atomically, push, and check hosted CI
argument-hint: "[message]"
---
Ship the changes authorized for this task.

1. Identify the task's acceptance criteria and the changed paths. Run the repo's required checks; fix failures and rerun. Exercise runnable changed behavior against the criteria, recording the command or interaction and observed result. Use the verifier agent when the user has enabled subagents; otherwise verify in this session. Report any unmet criterion or unavailable runtime and resolve it before claiming completion.
2. Review the diff and stage only authorized paths or hunks, preserving unrelated working-tree changes. Commit as focused, atomic Conventional Commits, ordered by dependency. Never use `git add -A`. Use `type(scope): subject`, with $@ as the headline subject if given.
3. Push once to origin. Record the pushed commit SHA and inspect hosted CI for that exact SHA. Wait for required checks and fix failures within scope. If no hosted CI is configured, report that limitation and stop waiting. Missing runs, pending checks, skipped jobs, or unavailable CI access are verification gaps, not a green result; report them explicitly. Do not treat CI success as evidence of deployment without checking the deployment itself.
4. Report acceptance evidence, check results, commit hashes with one-line summaries, branch, push result, and hosted CI status linked to the pushed SHA.
