# pi-toasts

Show extension notifications as small top-right cards that disappear on their
own, rather than permanent rows in the chat. They do not take keyboard focus
from your editor or dialogs. A little less transcript confetti.

Pi's own status, warning and error lines are unchanged. This only affects
extension calls to `ctx.ui.notify(...)` in the interactive terminal UI.
RPC, JSON and print modes keep normal notifications.

## Behaviour

The overlay is removed when the last toast expires, not just hidden. On `/reload`
or shutdown, timers are cleared and the original notification function is restored
if this extension still owns the wrapper.

Internally, the extension obtains the TUI through a `setWidget` factory rather
than `ctx.ui.custom()`, which would count as a blocking UI prompt.

## Settings (environment)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_TOAST_CAPTURE` | on | Set to `0` to leave `ctx.ui.notify` unchanged. |
| `PI_TOAST_WIDTH` | `44` | Card width in terminal columns, clamped to fit. |
| `PI_TOAST_MAX_VISIBLE` | `3` | Maximum visible cards; new ones replace the oldest above this limit. |
| `PI_TOAST_TIMEOUT_INFO` | `4000` | Info toast lifetime in milliseconds. |
| `PI_TOAST_TIMEOUT_WARNING` | `6000` | Warning toast lifetime in milliseconds. |
| `PI_TOAST_TIMEOUT_ERROR` | `8000` | Error toast lifetime in milliseconds. |

Toasts hide below 30 columns or eight rows. Text is truncated using pi-tui's
terminal-width helpers.

## Limitations

- Only extension notifications emitted after this package loads are captured.
  Pi's own transcript rows and project-trust dialogs are not.
- In Pi 1.4.0, switching TUI mode through `/settings` is blocked while a toast is
  visible. Wait for it to expire; there is no hook to dismiss it on opening settings.
- Ghostty / Herdr on macOS and layout during model streaming are not verified
  in CI. Unit tests cover timers and redraw hooks, not live streaming layout.
- Another extension calling `tui.hideOverlay()` can pop the topmost overlay,
  which may be this one (Pi 1.4.0 stack behaviour).
