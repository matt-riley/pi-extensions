# pi-footer

A work-oriented statusline: **project · branch · work state**, then model and
context pressure and model/thinking level when there is room. It uses the current theme, not a new one.

States reflect actual pi activity: `ready`, `planning` (read-only mode), or
`working`. `ready`
means idle, **not verified**. A backed-up workbench draft remains visible as
`draft saved`.

## Usage

Installed through the collection's root manifest; see the [root README](../../README.md).

- `/footer` toggles between the personal and built-in footer.
- `/footer details` shows token totals, cost and extension statuses on demand.
  Accounting stays out of the statusline; `/session` is still available.
- `/usage` shows assistant requests by provider/model, fresh input, output,
  cache reads/writes, reported cost and outer-session tool failures/pending calls.
  `/usage --json` displays the same report as JSON. Reports are custom session
  messages, visible in the transcript and subsequent context; neither command
  starts an agent turn or sends telemetry. Usage is recomputed on each command
  from the active branch, including retained pre-compaction entries. Other
  branches, child-session usage, hidden nested calls and latency are excluded.
  Missing/invalid costs remain unknown; zero-cost records are counted separately
  and do not imply free usage. Token totals with missing fields are partial,
  with the number of missing/invalid fields shown beside each model.

Workspace and work state take priority over model/accounting information in
narrow terminals. Layout measures terminal columns with pi-tui's own
`visibleWidth` and `truncateToWidth` (supplied by the pi host), so the footer
agrees with pi's line-width check on CJK, emoji, Thai, Devanagari and anything
else; names cannot inject terminal control sequences.
No Nerd Font is required. The layout lives in a new `workspace.mjs` module so
upgrading from the former footer through `/reload` does not hit pi's cached old
helper exports. Later edits to an already-loaded helper may still need a pi restart.

The footer refreshes on session/branch, model/thinking, tool and agent lifecycle
events. Planning status reads the existing plan-mode extension status.
Token totals cover assistant messages on the active branch. Cost uses configured
model pricing, not a billing-service quote. Nothing polls Git or calls a model.
