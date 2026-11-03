# pi-footer

Keep the basics in view: **project · branch · work state**, with model, thinking
level and context usage when there is room. It uses your current pi theme and
needs no special font.

The states are `ready`, `planning` (read-only mode), and `working`.
**Ready means idle, not verified.** A backed-up prompt shows as `draft saved`.

## Usage

Install it with the [collection](../../README.md#install), then use:

| Command | What it shows |
| --- | --- |
| `/footer` | Toggle between this footer and pi's built-in one. |
| `/footer details` | Token totals, cost and extension statuses. `/session` is still available. |
| `/usage` | Requests, tokens, reported costs and tool failures grouped by provider/model. |
| `/usage --json` | The same usage report as JSON. |

Accounting stays out of the statusline until you ask for it. Narrow terminals
keep the workspace and work state before model details.

## What the usage report counts

`/usage` reads the active session branch, including retained pre-compaction
entries. It counts assistant requests, fresh input, output, cache reads/writes,
reported cost, and outer-session tool failures or pending calls.

Other branches, child-session usage, hidden nested calls and latency are not
included. Missing or invalid costs stay unknown. Zero-cost records are counted
separately; they do not prove usage was free. Partial token totals show how many
fields are missing or invalid.

Reports appear in the transcript and subsequent model context. The commands do
not start an agent turn or send telemetry. Cost uses configured model pricing,
not a billing-service quote.

## Layout and updates

The footer measures terminal columns with the host's `visibleWidth` and
`truncateToWidth`, including wide and combining characters. Names cannot inject
terminal control sequences.

It refreshes on session, branch, model, thinking, tool and agent lifecycle events.
Planning status comes from the plan-mode extension. Nothing polls Git or calls a
model.

The layout lives in `workspace.mjs` so `/reload` can upgrade from the older footer
without reusing cached helper exports. Later edits to an already-loaded helper
may still need a pi restart.
