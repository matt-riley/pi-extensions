# pi-watch-pr: where a pull request stands

See what still needs attention on a pull request: failed or running checks,
conflicts, requested changes, and unresolved review threads. It needs an
authenticated `gh` CLI and never changes the PR.

The agent calls `watch_pr(pr?, wait_seconds?)`. Each read reports the PR's
**head commit**, its SHA, and one of these verdicts:

| Verdict | Meaning |
| --- | --- |
| `needs-action` | Something to fix: failed check, conflict, behind base, required review, policy block, unresolved thread or draft |
| `unknown` | Evidence is missing, unrecognized, incomplete or from a different head; not ready |
| `pending` | Nothing to fix, but checks are still running |
| `ready` | Nothing outstanding on this head |
| `closed` | Merged or closed |

No checks reported means `unknown`, never `ready`. Unknown check conclusions,
unavailable reviews and unknown merge states also prevent readiness. Known
blockers still return `needs-action` even when other evidence is incomplete.

Reviews follow the returned PR URL, including its repository and host, rather
than the workspace's repository. The tool uses `gh api --paginate --slurp` to read
every review-thread page and checks that each page refers to the reported head.
Failed or malformed retrieval cannot count as an empty successful review.
Outdated and resolved threads are not counted.

With `wait_seconds` (max 600) it polls every 20s while the verdict is `pending`,
and stops early on anything else, including `unknown`.

## `verified:`

The last line of every report says whether the change was verified, separately
from the verdict. CI being green is not the same as "this was verified":

| Line | Meaning |
| --- | --- |
| `verified: yes (patch unchanged since <sha>)` | The session's newest verifier verdict is `verified` and its patch id equals the PR's |
| `verified: stale (patch changed since <sha>)` | The PR's patch changed after the verdict, so the verdict no longer covers it |
| `verified: no (latest verifier verdict was …)` | The newest verdict was `failed`, `partially verified` or unreadable |
| `verified: no verdict recorded` | No verifier ran in this session |
| `verified: unknown (…)` | No patch id was recorded, or the PR's head or base is not available locally |

`pi-subagents` records a `verifier-verdict` session entry each time a `verifier`
child finishes: its verdict, the commit it ended on, and the patch id of the
working tree against the default branch. The PR's patch id is `git patch-id
--stable` of the diff from the merge base of `origin/<base>` (or `<base>`) to
the PR's head commit, from local refs only; nothing is fetched. A patch id is
unaffected by a rebase, which changes every SHA without failing a check, and
changes when the content does. This line never changes the verdict: `ready`
still means GitHub's view.

It never pushes, rebases, resolves a thread or merges. A `ready` verdict is not
permission to merge; that decision stays with you. The tool is deferred until
found through tool search.

## Tests

`node --test packages/watch-pr/test/*.test.mjs`: check classification, each
verdict, thread filtering, paginated snapshot assembly, head consistency and
cross-repository targeting against a fake `gh`. `verified.test.mjs` checks that a
patch id survives a rebase, that a dirty tree's id matches the same change once
committed, and that an amended head turns the line `stale` while the verdict stays
`ready`. `npm run smoke` also exercises
ready, incomplete, changed-head and later-page-thread cases through the real Pi
host with an isolated CLI fixture; it does not contact GitHub.
