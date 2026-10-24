# pi-watch-pr — where a pull request stands

`watch_pr(pr?, wait_seconds?)` is one read through `gh` of a PR's checks on its
**head commit**, merge state (conflicts, behind base), requested changes and
unresolved review threads. It returns a verdict and the head SHA it applies to:

| Verdict | Meaning |
| --- | --- |
| `needs-action` | Something to fix, listed one per line: failed check, conflict, behind base, changes requested, unresolved thread, draft |
| `pending` | Nothing to fix, but checks are still running |
| `ready` | Nothing outstanding on this head. Not authority to merge |
| `closed` | Merged or closed |

A PR with no checks reported is flagged as a gap, never a pass. Outdated and
resolved threads are not counted. With `wait_seconds` (max 600) it polls every
20s while the verdict is `pending`, and stops early on anything else.

Read-only: it never pushes, rebases, resolves a thread or merges. The fix, rebase
and push loop stays with the agent; this is the looking.

Needs an authenticated `gh`. Deferred tool, so it costs nothing in the prompt
until searched for.

## Tests

`node --test packages/watch-pr/test/*.test.mjs` — check classification, each
verdict, thread filtering, and snapshot assembly against a fake `gh`.
