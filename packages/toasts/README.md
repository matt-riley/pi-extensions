# pi-toasts

Reroutes **extension** `ctx.ui.notify(...)` in interactive TUI mode into small
top-right cards that close on their own, instead of permanent rows in the chat
transcript. Pi core’s own status, warning, and error lines are unchanged.

## Behaviour

- **TUI only.** RPC, JSON, and print modes keep Pi’s normal `notify`.
- **Non-capturing overlay** anchored top-right; the editor and dialogs keep keyboard focus.
- **Widget-factory route** to obtain the TUI (`setWidget` factory), not `ctx.ui.custom()` (that counts as a blocking UI prompt).
- When the last toast expires, the overlay is **removed** with its own handle (not merely hidden), so nothing stays in Pi’s overlay stack.
- On `/reload` or session shutdown, timers are cleared and `notify` is restored only if it is still this extension’s wrapper.

## Settings (environment)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_TOAST_CAPTURE` | on | Set to `0` to leave `ctx.ui.notify` unchanged. |
| `PI_TOAST_WIDTH` | `44` | Overlay width in columns (Pi clamps to the terminal). |
| `PI_TOAST_MAX_VISIBLE` | `3` | Maximum stacked cards; oldest dropped when exceeded. |
| `PI_TOAST_TIMEOUT_INFO` | `4000` | Info toast lifetime (ms). |
| `PI_TOAST_TIMEOUT_WARNING` | `6000` | Warning toast lifetime (ms). |
| `PI_TOAST_TIMEOUT_ERROR` | `8000` | Error toast lifetime (ms). |

Narrow terminals: the overlay hides when width &lt; 30 or height &lt; 8 (`visible(w,h)` on the overlay). Lines are truncated with pi-tui’s `visibleWidth` / `truncateToWidth`.

## Limitations

- Only **`ctx.ui.notify` from extensions** is captured. Pi’s own transcript rows, messages before this extension loads, and project-trust UI are not.
- **`/settings` TUI mode switch** is blocked while any overlay entry exists (Pi 1.4.0). With no toast visible, this extension removes the overlay entirely, so switching works. **While a toast is still on screen**, switching still shows Pi’s “Close active overlays…” message until the toast expires. There is no hook to dismiss toasts when opening `/settings`.
- **Ghostty / Herdr on macOS** and behaviour during **model streaming** are not verified in CI (unit tests cover timer + `onChange` redraw hooks; live streaming layout is not exercised here).
- Another extension calling `tui.hideOverlay()` could pop the topmost overlay, not necessarily this one (Pi 1.4.0 stack behaviour).
