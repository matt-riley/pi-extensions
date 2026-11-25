# pi-recover: a crash-recovery note for a cut-off session

When a Pi session is cut off mid-turn and later resumed, the agent cannot tell
which tool calls finished and which may have only partly run. This extension
records that, then adds one note. It never continues the turn on its own.

There is nothing to configure after you [install the collection](../../README.md#install).

## What it does

1. Each tool call is written as a session entry before it runs, and again when
   it finishes. The entries store the tool name and call id only, not arguments
   or results.
2. When a session starts, the journal is read from after the last recover
   note or the last completed assistant turn. If that turn was cut off
   (a tool started and never finished, or the last assistant turn was aborted),
   one note is added: what finished, what may have partly run, and "check the
   current state before repeating". The lists cover only that cut-off turn
   (records since the last user message), and each is capped at the last 20
   calls, with a "+N more" count if there are more. The note is a `recover`
   prompt section on the next user prompt, and a session entry so it is
   recorded. It is added once for that cutoff.
3. If the journal is missing or unreadable, the note says so rather than
   guessing a list. A new or cleanly finished session gets no note. A later
   clean turn after an old, unfinished call also gets no note.

Nothing is started automatically, and no panes are opened.

## Limits

- A cutoff from before this extension was loaded has no journal. If the last
  turn was aborted, the note says the journal is missing; otherwise it stays
  silent.
- Tool arguments are not stored, so the note can name a call but not what it
  was asked to do.
- The prompt section is for your own prompts, not injected follow-ups. It is
  reported once.

No model call and no network.
