// index.ts — pi extension: recover.
//
// Journal each tool call before it runs and when it finishes, as session
// entries. When a cut-off session is resumed, add one prompt note of what
// finished, what may have partly run, and "check the current state before
// repeating". Never continue the turn automatically. If the journal is missing
// or unreadable, say so rather than guessing.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  JOURNAL_TYPE,
  NOTE_TYPE,
  journalEntry,
  recoveryNote,
  summarizeRecovery,
} from "./recover.mjs";

export default function piRecoverExtension(pi: ExtensionAPI) {
  let pending: string | null = null;

  const inspect = (_event: unknown, ctx: { sessionManager?: { getBranch?: () => unknown } }) => {
    let entries: unknown;
    try {
      entries = ctx?.sessionManager?.getBranch?.();
    } catch {
      entries = undefined;
    }
    const note = recoveryNote(summarizeRecovery(entries));
    pending = note;
    if (note) pi.appendEntry?.(NOTE_TYPE, { version: 1, text: note });
  };

  for (const name of ["session_start", "session_tree"] as const) pi.on(name, inspect);

  pi.on("tool_call", (event) => {
    const data = journalEntry("started", event, Date.now());
    if (data) pi.appendEntry?.(JOURNAL_TYPE, data);
  });

  pi.on("tool_result", (event) => {
    const data = journalEntry("finished", event, Date.now());
    if (data) pi.appendEntry?.(JOURNAL_TYPE, data);
  });

  pi.on("before_agent_start", (event) => {
    if (event?.messageType !== "user" || !pending) return;
    event.systemPromptOptions.sections.recover = pending;
    pending = null;
  });
}
