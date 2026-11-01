---
description: Carry a coding task through investigation, implementation, verification and review
argument-hint: "<task>"
---
Complete this task using the existing repository workflow: $@

1. Investigate. Read applicable AGENTS.md, trace the affected implementation and its callers, and state the expected behavior as checkable acceptance criteria before editing.
2. Pick the smallest workable approach. A large ticket splits into independent subtasks that can run in parallel; a dependency chain runs in order with each result pasted forward. With subagents on, a task spanning recon, edit and proof runs scout, then worker, then verifier on the final diff, reporting each phase.
3. Implement one complete vertical slice at a time; for nontrivial behavior follow the `test-driven-development` skill. Reproduce a bug before changing it.
4. Verify against the acceptance criteria and the project's verification recipe, with the command whose output proves the end state, and bound any retry loop with `/until`.
5. Review the final diff with the `implementation-review` skill, fix supported defects, rerun the checks they affect, and report what changed, what was measured and what stayed unverified.

Keep the phases proportional to the task: a small edit needs no ceremony. If context runs tight, compact or hand off, retaining the task, decisions, changed paths and open acceptance checks.
