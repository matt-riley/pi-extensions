# pi-workbench

A personal front door to pi’s existing commands, project context and Git changes.
Uses pi’s host-provided widgets: no installed runtime dependencies, model calls or
global keybinding changes.

| Command | Shortcut | Purpose |
| --- | --- | --- |
| `/ui [words]` | Ctrl+Alt+K | Live command search by name, group or intent |
| `/files [words]` | Ctrl+Alt+F | Live file search; insert a plain quoted reference |
| `/changes [words]` | Ctrl+Alt+G | Browse staged, unstaged and untracked changes |
| `/ui restore` | Search “Restore saved draft” | Recover/swap a saved prompt draft |

Type to filter immediately; arrows navigate, Enter chooses, Escape cancels.
Search requires every word; name matches rank ahead of description matches.
There is no 200-match cutoff. Empty results remain searchable. Native `Input`
handles editing, paste and cursor focus; `SelectList` handles selection.
Shortcuts depend on terminal modifier support; slash commands always work.

## Commands and drafts

Command choices **prepare** the slash command in the editor. Press Enter to
execute it normally. Built-ins are never passed to `sendUserMessage` (which
would send them to the model instead of opening their native UI).

An existing prompt is backed up as a non-context `workbench-draft` session
entry before replacement. `/ui restore` swaps it with the current editor text;
if the editor is empty, it restores and clears the backup. A second preparation
cannot overwrite an existing backup. Reload restores the backup from the active
branch, including after tree navigation. Session changes retain it in the original
session, not the destination. Normal session retention/privacy rules apply.

Existing session tree/resume, labels, planning, subagent controls, prompts and
skills remain their own implementations. Subagents are never enabled by the UI.

### Mistyped slash commands

A close misspelling such as `/eixt` is consumed before reaching the model. The
original text and arguments are restored, and a notification suggests `/exit`.
**Nothing is autocorrected or executed**: edit it and submit again. Prefix it with
ordinary text to discuss a literal command instead.

Suggestions use the current extension/prompt/skill registry plus pi 1.4’s built-in
names. The guard recognizes one insertion, deletion, substitution or adjacent
transposition (and wrong case). It deliberately leaves distant unknown names,
paths, slash prose, multiline prompts, RPC/extension input and image-bearing
messages alone; images cannot be restored through the editor-text API.

## Files and changes

File inventory reuses code-search’s Git-aware inventory and non-Git fallback.
In a Git repository it covers the whole repository, including from a subdirectory.
Ignored files are omitted; the existing inventory cap is 50,000 paths.

Inserting a reference preserves the prompt and never reads the file or inserts
`@file` (pi would expand that attachment on submission). The model may subsequently
read the referenced file when you submit the prompt.

Changes keep staged and unstaged versions separate, including a file changed in
both places. Enter opens a **non-editable** diff directly:

- Up/Down, PageUp/PageDown and Home/End scroll.
- Left/Right move between changes in the filtered list, wrapping at either end.
- `e` opens the current worktree file in read-only Neovim; return resumes the diff.
- `i` inserts a file reference and ends the review.
- Escape returns to the list with its query and selected file/scope intact.

Each file/scope keeps its own scroll position for the duration of the review.
Scope stays in the header. Diffs disable external diff/textconv drivers and treat
filenames literally. Previews are capped at 20,000 characters, explicitly marked
when truncated, and terminal control bytes are escaped before display.

Neovim runs `nvim -R -- <absolute-path>` without a shell, temporarily releasing
the TUI. It shows the **worktree**, not the staged snapshot; read-only mode can
still be overridden manually in Neovim.

The workbench is user-invoked and terminal-only. It refuses to open while the
agent is busy, avoiding approval/tool-dialog focus theft. No automatic staging,
commits, Git mutations, permanent sidebar or Vim emulation.

## Verification

From the repository root, run `node .pi/verify/workbench.mjs --upgrade` and
`node .pi/verify/workbench.mjs --regular` (requires pi, tmux, Neovim and Git).
The isolated real-terminal fixture checks live filtering, cancellation, draft
recovery, file references, non-editable scoped diffs, retained review position,
actual Neovim handoff, `/eixt` interception, narrow resize, Unicode paths and
real agent lifecycle against a local scripted provider. It checks that browsing
and typo interception change neither the worktree/index nor call a model.
See [the repository recipe](../../docs/verification.md) for the remaining gates.
