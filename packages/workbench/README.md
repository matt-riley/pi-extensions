# pi-workbench

A personal front door to pi's existing commands, project context and Git changes.
No additional dependencies, model calls or global keybinding changes.

| Command | Shortcut | Purpose |
| --- | --- | --- |
| `/ui [words]` | Ctrl+Alt+K | Grouped command centre; search by name or intent |
| `/files [words]` | Ctrl+Alt+F | Find a file and insert a plain quoted reference |
| `/changes [words]` | Ctrl+Alt+G | Browse staged, unstaged and untracked changes |
| `/ui restore` | Through the Draft group | Recover/swap a saved prompt draft |

Uses pi's native input and selection dialogs: arrows to navigate, Enter to
choose, Escape to cancel. Choose **Search…** to enter search words, then choose
from the filtered results. This is search-then-select, not live fuzzy filtering.
Search requires every word; name matches rank ahead of description matches.
Lists show up to 200 matches; search again to narrow larger inventories.
Shortcuts depend on terminal modifier support; slash commands always work.

## Commands and drafts

Command choices **prepare** the slash command in the editor. Press Enter to
execute it normally. Built-ins are never passed to `sendUserMessage` (which
would send them to the model instead of opening their native UI).

An existing prompt is backed up as a non-context `workbench-draft` session
entry before replacement. `/ui restore` swaps it with the current editor text;
if the editor is empty, it restores and clears the backup. A second preparation
cannot overwrite an existing backup. Reload restores the backup from the active
branch, including after tree navigation. Session changes retain it in the original session, not the destination.
Normal session retention/privacy rules also apply to backed-up draft text.

Existing session tree/resume, labels, planning, subagent controls, prompts and
skills remain their own implementations. Subagents are never enabled by the UI.

## Files and changes

File inventory reuses code-search's Git-aware inventory and non-Git fallback.
In a Git repository it covers the whole repository, including from a subdirectory.
Ignored files are omitted; the existing inventory cap is 50,000 paths.

Inserting a reference preserves the prompt and never reads the file or inserts
`@file` (pi would expand that attachment on submission).
The model may subsequently read the referenced file when you submit the prompt.

Changes keep staged and unstaged versions separate, including a file changed in
both places. Diffs disable external diff/textconv drivers and treat filenames
literally. Preview uses a disposable native editor scratch buffer; **edits are
discarded**, never saved to files or the index. Previews are capped at 20,000
characters and explicitly marked when truncated. Terminal control bytes are escaped before display.
Open in Neovim runs `nvim -R -- <absolute-path>` without a shell, temporarily
releasing the TUI. Read-only mode can still be overridden manually in Neovim.

The workbench is user-invoked and terminal-only. It refuses to open while the
agent is busy, to avoid taking focus from approval/tool dialogs.
No automatic staging, commits, Git mutations, permanent sidebar or modal editor.

## Verification

From the repository root, run `node .pi/verify` and `node .pi/verify --regular`
for isolated real-TUI acceptance in both pi UI modes. Add `--upgrade` to also
check upgrading the footer from HEAD through `/reload` (requires pi, tmux, Neovim,
and Git). This checks native keyboard navigation, draft recovery, file references,
staged/unstaged scratch previews, actual Neovim handoff, narrow resize, Unicode
paths, and real agent lifecycle against a local scripted provider. It verifies
that browsing changes neither the worktree/index nor calls a model. See
[the repository recipe](../../docs/verification.md) for the remaining gates.
