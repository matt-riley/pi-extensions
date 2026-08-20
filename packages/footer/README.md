# pi-footer

Replaces pi's built-in footer with an always-on status line showing, left to
right: **model** (provider/id) in the accent color, the **thinking level**
badge (color-coded per level), **extension statuses**, **↑input ↓output
token totals**, **$cost**, and the **git branch**.

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

## Notes

- Token totals are the running session totals (input + output across all
  assistant messages on the current branch), matching what pi reports in
  `/session`.
- Cost uses each model's configured pricing; cheap models show four decimal
  places.
- Under narrow terminals the footer degrades gracefully: it drops the branch
  first, then truncates the model label, then the thinking badge.
