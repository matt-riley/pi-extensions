---
description: Commit changes as atomic Conventional Commits and push
argument-hint: "[message]"
---
Commit the working tree as one or more atomic Conventional Commits, then push. Run the commits — do not print examples.

1. If `git status --short` is empty, say "nothing to commit" and stop.
2. Inspect the whole tree (`git status --short`, `git diff`, `git diff --cached`). Group unrelated changes into separate commits — one logical change per commit. A fix and a refactor of the same file become two commits, not one.
3. Order commits by dependency: a change another change builds on comes first. Source changes rank above tests, docs, and config, so the headline change is the first commit. Exclude lockfiles and generated files from the grouping decision.
4. Commit each group on its own: `git add` only the specific paths for that change (never `git add -A`), then `git commit -m` with `type(scope): subject` — imperative, lowercase, no trailing period; a short body only when the diff needs explanation. If the user supplied text, use it as the subject (or subject + body) of the headline commit.
5. Push once when every commit is made: `git push` to origin (current branch, or main).

Report each commit hash with a one-line summary, the branch, and the push result.

$@
