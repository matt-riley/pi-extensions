---
description: Carry a coding task through investigation, implementation, verification and review
argument-hint: "<task>"
---
Complete this task using the existing repository workflow: $@

1. Investigate. Read applicable AGENTS.md instructions, inspect the working tree and locate the affected implementation and callers. Use code search and `skill_select` when useful; read any selected SKILL.md before following it. Establish the expected behavior and observable acceptance criteria. Preserve unrelated edits.
2. Choose the smallest workable approach. For a substantial or uncertain change, outline ordered steps with a verification action for each. If read-only plan mode is already active, investigate and finish the plan through its existing controls; implementation waits until plan mode is exited. Do not treat this prompt as authority to bypass a tool gate. Resolve routine decisions autonomously and ask only for information needed to proceed.
3. Implement a complete vertical slice at a time. For nontrivial behavior, follow the `test-driven-development` skill. Reproduce a bug before changing it when feasible. Use existing terminal jobs for long-running checks; inspect their exit status and output. Use subagents only when the user has enabled them and a bounded, independent task benefits from delegation.
4. Verify against the acceptance criteria and the project's verification recipe. Run focused checks and required repository gates. After repeated failed fixes, use the existing diagnosis checkpoint to gather a discriminating observation before another edit. Use `/until` only for a bounded, explicit success predicate; never use an endless retry loop.
5. Review the final diff with the `implementation-review` skill. Correct supported defects and rerun checks affected by those corrections. Report what changed, the observed verification results and any remaining gaps. Finish within the user's authorization; committing, pushing, merging, deployment and installation require authorization from the task, not from this workflow prompt.

Keep these phases proportional to the task. A small edit does not need a ceremony or a new workflow engine. If context becomes tight, use existing safe-compaction/handoff support and retain the task, decisions, changed paths and remaining acceptance checks.
