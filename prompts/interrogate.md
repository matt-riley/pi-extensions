---
description: Adversarial review where several models try to break the change and only rerun-proven findings survive
argument-hint: "[scope]"
---
Use the `interrogate` skill (find it with `skill_select`, then read its `SKILL.md`) on $@, or on the branch diff from its merge base through the working tree when no scope is given. Report findings; do not fix them.
