---
description: Report where model spend and context went, and what to change
---

Before running bundled scripts, locate this collection with `pi list` (managed installs) or
Pi's active prompt/extension configuration and discovery directories (clones). Respect
`PI_CODING_AGENT_DIR` and project overrides. Verify the root contains
`prompts/cost.md` and the scripts below. Substitute its absolute path for
`<collection-root>`; keep paths quoted and the working directory unchanged. If the location is
missing or ambiguous, report it and stop rather than guessing or using another checkout.

Run `node "<collection-root>/scripts/context-report.mjs"` and read it as the source of truth; quote its numbers rather than estimating.

Report, briefly:

1. Total spend, spend per turn, and the share that is cache reads versus fresh input and output.
2. Cost concentration: any model taking a large share of spend on a small share of calls. Check whether `~/.pi/agent/router.json` still routes to it, and whether a cheaper model of the same family is in `pi --list-models`.
3. Compaction: where it fires (p50/p90) and whether large contexts are being re-sent.

End with at most three concrete changes (a `router.json` pair, a setting, a habit), each with the number that justifies it. If nothing stands out, say so.
