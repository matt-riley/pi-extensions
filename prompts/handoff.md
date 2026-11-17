---
description: Save or resume a small delegated-task handoff in the existing plan
argument-hint: "[save|resume]"
---

For a task that spans sessions, use the existing `.pi/PLAN.md`; do not introduce
a second task database. Read it before changing anything. Preserve the user's
plan and all content outside the bounded section below. If the marker already
exists more than once, or its closing marker is missing, report the ambiguity
rather than rewriting the file. Create the file only when it does not exist.

On `save` (the default), first reach a safe pause: finish or back out the current
atomic step, start nothing new, and leave no child running (wait for it, or ask me
to stop it with `/subagents`). Then update only one section between these exact
markers:

```markdown
<!-- delegated-task:start -->
## Delegated task handoff
- Objective:
- Authorized scope and explicit approval boundaries:
- Target: repository, base/head, dirty-state fingerprint when available:
- Completed acceptance evidence: criterion, command/result, source transcript:
- Remaining work and unexercised criteria:
- Blocker or required decision:
- Tree state: clean, or the uncommitted paths and why they are left:
- First action on resume:
<!-- delegated-task:end -->
```

Keep it short: source pointers rather than pasted logs; distinguish execution
completion from verified acceptance. Preserve existing evidence with its original
revision instead of silently relabeling it current. Do not copy credentials.
After saving, tell me whether the working tree is clean and what the first action on resume is.

On `resume`, read the section and relevant evidence, then compare its revision
and scope with current Git state and the user's latest request. Stale evidence
must be rerun when needed; missing fingerprints mean identity is unverified.
Report the next concrete action and unresolved decision. Reading the record does
not authorize new work, enable subagents, launch children or resume them. Continue
only work already authorized in the current conversation.
