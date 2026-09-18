// index.ts — pi extension: the diagnosis-check reminder.
//
// When a tool call fails, a wrong-but-plausible root cause is about to be
// written down. tool_result handlers cannot inject messages, but they can patch
// the result the model is about to read, so the reminder rides along with the
// failure itself — the only moment it can still change the next action.
//
// Text only: it never blocks a tool call (a non-zero exit from grep would make
// a gate misfire), adds no dependency, and is re-armed by the next failure.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { appendNudge, createNudgeState, observeToolResult, resetNudgeState } from "./nudge.mjs";

export default function piDiagnosisNudgeExtension(pi: ExtensionAPI) {
  const state = createNudgeState();

  pi.on("session_start", async () => {
    resetNudgeState(state);
  });

  pi.on("tool_result", async (event) => {
    const outcome = observeToolResult(state, {
      toolName: event?.toolName,
      isError: event?.isError === true,
    });
    if (!outcome.nudge || !outcome.text) {
      return;
    }
    return { content: appendNudge(event?.content, outcome.text) };
  });
}
