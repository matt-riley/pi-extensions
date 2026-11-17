# pi-emphasis: replies you can scan

Turns `[[Done]]`, `[[Failed]]` and `[[Needs you]]` in the agent's replies into
colored pills with icons, gives known headings and lead labels an icon, and
colors bold text, arrows and tree lines with your theme.

It changes only what is drawn. The stored message, copied text and HTML exports
keep the original Markdown. No model call and no network.

Adapted from [pi-emphasis](https://github.com/johnlindquist/pi-emphasis) by
John Lindquist (MIT). This version passes its options in rather than reading
them deep in the renderer, uses the collection's `PI_*=0` flag reading, checks
the terminal mode instead of `hasUI`, and adds the evidence words this
collection asks for (see [Vocabulary](#vocabulary)).

There is nothing to configure after you [install the collection](../../README.md#install).

## Requirements

- A terminal that draws [Nerd Font](https://www.nerdfonts.com/) symbols, for the
  icons and the rounded pill ends. Check with
  `printf '  \n'`: you should see a half circle, a
  check mark, a question mark, a person and another half circle. Ghostty, kitty
  and WezTerm usually pass with any font. Without the symbols, set
  `PI_EMPHASIS_PILL_ICONS=0` and `PI_EMPHASIS_ROUND_CAPS=0`.
- A theme with panel colors. Pi's `system` theme, when the terminal reports
  none, draws every pill in reverse video in one color; pick a theme with `/theme`.

## What it does

1. **Draws.** A Markdown transformer rewrites assistant replies before pi renders
   them. Your own messages, thinking blocks, fenced code, inline code and
   escaped asterisks are left alone.
2. **Teaches.** In the terminal interface only, it adds a `reply_style` section
   to the system prompt: which pill word to use for each state, that every
   failure, ask and unchecked claim carries a pill, and that each attention pill
   is followed by its action (**Check:**, **Do:**, **Next:** …). The word lists
   are read from the same tables that color the pills, so the rules and the
   drawing cannot drift apart. It is about 1,500 tokens (5,935 characters) on
   every request; it never changes within a session, so after the first request
   it is normally read from the prompt cache. It shows in safe-compact's
   `view_context` size view. RPC, JSON and print runs get no section, because
   nothing there draws pills.

## Vocabulary

| Color | Meaning | Words |
| --- | --- | --- |
| Red | Something is wrong | Failed, Blocked, Broken, Unsafe |
| Yellow | Look here | Needs you, Decision, Unverified, Attempted, Partial, Skipped, In progress, Pending, At risk |
| Green | Settled | Done, Passed, Observed, Fixed, Live, Recommended, Keep |
| Solid red | Consequences | Costs money, Destructive, Irreversible |
| Cyan | Kind of work | Brainstorm, Investigate, Preview, Implement, Qualify |
| Solid blue | Ownership | Owned, Shared, Foreign |
| Soft blue | Context | Inferred, New, Changed, Optional, and any other label |

A known word may carry detail: `[[Passed 12/12]]`, `[[Failed: 3 tests]]`,
`[[Passed on CI]]`. Synonyms display as one word: Completed and OK show as Done,
Error as Failed, Unknown as Unverified. A label longer than 32 characters is
left as typed.

The additions over the original line up with the collection's verification
rules: a check is passed, failed, attempted or unverified, and the guidance
asks for where a check ran (`[[Passed locally]]` against `[[Passed on CI]]`),
because a local pass is not a CI pass.

Headings and leading bold labels such as **Cause:**, **Fix:**, **Risk:**,
**Plan:** and **Next:** take an icon from their word. `✓` takes the success
color, `✗` the error color, `→` the accent color, and `├──`/`└──` are dimmed.

## Settings

Environment variables, set before starting pi:

- `PI_EMPHASIS=0`: no drawing and no prompt section.
- `PI_EMPHASIS_GUIDANCE=0`: keep the drawing, write your own rules.
- `PI_EMPHASIS_PILL_ICONS=0`: no icons in pills or on labels.
- `PI_EMPHASIS_ROUND_CAPS=0`: square chips, for fonts without Nerd Font symbols.
- `PI_EMPHASIS_COLOR`: theme color for bold text (default `mdLink`). An unknown
  color name makes the transformer throw; pi then shows the reply undecorated.

To add a word, icon or synonym, edit the tables at the top of `emphasis.mjs`.

## Limits

- A bold span that continues onto a second source line is colored only on its
  first line.
- Pills are drawn on assistant replies only, not on extension messages such as
  background-job notices.
- The original was checked on macOS in Ghostty and the Herdr app; this port has
  the same terminal assumptions.
