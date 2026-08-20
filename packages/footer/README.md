# pi-footer

Replaces pi's built-in footer with an always-on status line showing, left
to right: **model** (robot glyph + provider/id) in the accent color, the
**thinking level** badge (brain glyph, color-coded per level),
**extension statuses**, **↑input ↓output token totals** (link/warning),
**$cost** (success), the **current directory name** (folder glyph, muted),
and the **git branch** (branch glyph, muted).

The footer re-renders live when the model changes (Ctrl+P), the thinking
level changes (Shift+Tab), a message completes (token totals tick up), or
the git branch changes.

## Install

Installed as part of the `pi-extensions` collection (see the [root
README](../../README.md)). Standalone registration comes later with npm
publishing.

## Usage

The custom footer is on by default. Toggle it:

```text
/footer
```

`/footer` restores the built-in footer when off, and reinstates the custom
one when on.

## Requirements

Glyphs are [Nerd Font](https://www.nerdfonts.com) v3 icons — your terminal
needs a Nerd Font installed (MonoLisa ships a paid NF variant; free
alternatives include JetBrains Mono Nerd Font and MesloLGM Nerd Font) or
they render as empty boxes. `/footer` restores the built-in footer if you
want the plain look back.

## Notes

- Token totals are the running session totals (input + output across all
  assistant messages on the current branch), matching what pi reports in
  `/session`.
- Cost uses each model's configured pricing; cheap models show four decimal
  places.
- Under narrow terminals the footer degrades gracefully: it drops the branch,
  then the directory name, then cost and token counts, then truncates the
  model label, then the thinking badge.
