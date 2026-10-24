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

Workspace and work state take priority over model/accounting information in
narrow terminals. Layout measures terminal columns, including CJK characters,
combining marks and emoji; names cannot inject terminal control sequences.
No Nerd Font is required. The layout lives in a new `workspace.mjs` module so
upgrading from the former footer through `/reload` does not hit pi's cached old
helper exports. Later edits to an already-loaded helper may still need a pi restart.

The footer refreshes on session/branch, model/thinking, tool and agent lifecycle
events. Planning status reads the existing plan-mode extension status.
Token totals cover assistant messages on the active branch. Cost uses configured
model pricing, not a billing-service quote. Nothing polls Git or calls a model.
