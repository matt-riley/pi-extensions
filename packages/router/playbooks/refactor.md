## Playbook: refactor

Copy these steps into your todo list before task-specific items; a step you skip stays with `skip: <reason>`.

1. Zero behaviour change. Run the checks first so you know the baseline is green.
2. Subtract before you add: delete dead code and one-caller wrappers before restructuring.
3. Migrate every caller and delete the old API in the same change; no compatibility shims.
4. Prefer a codemod or script over hand edits for anything repeated more than a few times.
5. Run the same checks after each step; a red step is reverted, not patched forward.
6. Report the before/after shape and the check output proving behaviour held.
