// index.ts — pi extension: the diagnosis-check reminder.
//
// When a tool call fails, a wrong-but-plausible root cause is about to be
// written down. tool_result handlers cannot inject messages, but they can patch
// the result the model is about to read, so the reminder rides along with the
// failure itself — the only moment it can still change the next action.
//
// Text only: it never blocks a tool call (a non-zero exit from grep would make
// a gate misfire), adds no dependency, and is re-armed by the next failure.
//
// When a TypeSafe key is reachable, the failure is also classified: a code bug
// reported as "retry after the flake" is the expensive version of this mistake,
// and an output carrying a credential must not be quoted again. The judgment
// is strictly best effort — it is awaited only so it can ride on the same
// result, it takes its own deadline, and every failure of it is simply no
// classification.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { messageText } from "../../shared/message-text.mjs";
import { resolveApiKey } from "../../shared/systemone.mjs";
import { appendNudge, createNudgeState, observeToolResult, resetNudgeState } from "./nudge.mjs";
import { judgeFailure, memoKeyFor, shouldTriage, triageText } from "./triage.mjs";

export const TRIAGE_ENV = "PI_DIAGNOSIS_TRIAGE";

/** Off means off: anything but a yes leaves the deterministic nudge alone. */
function triageEnabled(env = process.env) {
  const flag = String(env?.[TRIAGE_ENV] ?? "")
    .trim()
    .toLowerCase();
  if (["0", "false", "off", "no"].includes(flag)) {
    return false;
  }
  try {
    // No key, no request: selection is skipped rather than attempted and lost.
    return Boolean(resolveApiKey(env));
  } catch {
    return false;
  }
}

/** The part of a tool call worth judging: what it tried to do. */
function actionOf(input) {
  if (!input || typeof input !== "object") {
    return typeof input === "string" ? input : "";
  }
  for (const key of ["command", "path", "file_path", "pattern", "query", "url"]) {
    if (typeof input[key] === "string" && input[key]) {
      return input[key];
    }
  }
  try {
    return JSON.stringify(input);
  } catch {
    return "";
  }
}

export default function piDiagnosisNudgeExtension(pi: ExtensionAPI) {
  const state = createNudgeState();

  pi.on("session_start", async () => {
    resetNudgeState(state);
  });

  pi.on("tool_result", async (event, ctx) => {
    const isError = event?.isError === true;
    const outcome = observeToolResult(state, { toolName: event?.toolName, isError });
    const parts: string[] = [];
    if (outcome.nudge && outcome.text) {
      parts.push(outcome.text);
    }

    if (isError && triageEnabled()) {
      const output = messageText(event?.content);
      const key = memoKeyFor({ toolName: event?.toolName, output });
      if (shouldTriage(state, key)) {
        const judged = await judgeFailure({
          toolName: event?.toolName,
          action: actionOf(event?.input),
          cwd: ctx?.cwd ?? process.cwd(),
          output,
        });
        const line = triageText(judged);
        if (line) {
          // The class goes first: it decides whether the next action is a
          // retry at all, which the diagnosis nudge assumes.
          parts.unshift(line);
        }
      }
    }

    if (parts.length === 0) {
      return;
    }
    return { content: appendNudge(event?.content, parts.join("\n")) };
  });
}
