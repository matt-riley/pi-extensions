// index.ts — on-demand /improve: hosted rewrite, TypeSafe intent check, hand-off.
//
// This deliberately does not intercept ordinary input. The user asks for an
// improvement explicitly, a hosted model writes, TypeSafe checks preservation,
// and the result lands in pi's input box. Nothing is sent: Matt edits the text
// and presses Enter. Any failure puts the original prompt there instead of
// silently losing the task. A rewrite the intent check rejects is shown to him
// with the reason, and only goes in the box if he confirms it.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { askSystemOne } from "../../shared/systemone.mjs";
import { bindSystemOne } from "../../shared/systemone-session.mjs";
import { buildCoachQuestions } from "./battery.mjs";
import { extractLastUserPrompt, usableNoul, validateCandidate } from "./lib.mjs";
import { collectProbe } from "./probe.mjs";
import { DEFAULT_TIMEOUT_MS, rewriteWithModel } from "./rewrite.mjs";

const COMMAND = "improve";
const STATUS_ID = "prompt-coach";
const DEFAULT_INTENT_THRESHOLD = 0.7;
const DEFAULT_INTENT_TIMEOUT_MS = 2_500;

type CoachExec = (
  cmd: string,
  args: string[],
  opts?: { timeout?: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

type CoachFetch = typeof fetch;

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function notify(ctx: ExtensionContext, text: string, level = "info") {
  try {
    ctx.ui?.notify?.(text, level);
  } catch {
    // Feedback must never make the command fail.
  }
}

function setStatus(ctx: ExtensionContext, text: string) {
  try {
    ctx.ui?.setStatus?.(STATUS_ID, text);
  } catch {
    // Status is decoration.
  }
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export default function piPromptCoachExtension(
  pi: ExtensionAPI,
  deps: {
    ask?: typeof askSystemOne;
    exec?: CoachExec;
    fetchImpl?: CoachFetch;
    env?: Record<string, string | undefined>;
  } = {},
) {
  bindSystemOne(pi);
  const ask = deps.ask ?? askSystemOne;
  const run: CoachExec = deps.exec ?? ((cmd, args, opts) => pi.exec(cmd, args, opts));
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const env = deps.env ?? process.env;
  const intentThreshold = Math.min(
    1,
    Math.max(0, envNumber("PI_PROMPT_COACH_INTENT_THRESHOLD", DEFAULT_INTENT_THRESHOLD)),
  );
  const rewriteTimeoutMs = envNumber("PI_PROMPT_COACH_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const intentTimeoutMs = envNumber("PI_PROMPT_COACH_INTENT_TIMEOUT_MS", DEFAULT_INTENT_TIMEOUT_MS);

  const record = (data: Record<string, unknown>) => {
    try {
      pi.appendEntry?.("prompt-coach-decision", { at: Date.now(), version: 3, ...data });
    } catch {
      // Telemetry must never block the requested task.
    }
  };

  /** Put text in Pi's input box above any draft. Matt edits it and presses Enter. */
  const place = (ctx: ExtensionContext, text: string): boolean => {
    const ui = ctx.ui;
    if (!ui?.setEditorText) return false;
    const draft = ui.getEditorText?.() ?? "";
    ui.setEditorText(draft.trim() ? `${text}\n\n${draft}` : text);
    return true;
  };

  /** Ask Matt whether to use a rewrite the intent check rejected. No UI, or any dialog error, means no. */
  const confirmRejected = async (
    ctx: ExtensionContext,
    original: string,
    rewrite: string,
    why: string,
  ): Promise<boolean> => {
    if (!ctx.hasUI || !ctx.ui?.confirm) return false;
    try {
      return (
        (await ctx.ui.confirm(
          "Use the rewrite the intent check rejected?",
          `Rejected because ${why}.\n\nRewrite:\n${rewrite}\n\nYour original:\n${original}\n\nConfirm to put the rewrite in the input box, or deny to keep your original.`,
        )) === true
      );
    } catch {
      return false;
    }
  };

  pi.registerCommand(COMMAND, {
    description: "Improve a prompt with a hosted model and put it in the input box to edit",
    handler: async (args: string, ctx: ExtensionContext) => {
      const typed = String(args ?? "").trim();
      const branch = ctx.sessionManager?.getBranch?.() ?? [];
      const original = typed || extractLastUserPrompt(branch);
      if (!original) {
        notify(ctx, "Usage: /improve <rough prompt> (or run it after a user prompt)", "warning");
        return;
      }

      setStatus(ctx, "prompt-coach: improving");
      const probe = await collectProbe(run, original);
      let candidate = original;
      let filesRead: string[] = [];
      let rewriteError: string | null = null;
      let usedModel: string | null = null;
      let subscription: boolean | null = null;

      try {
        const rewrite = await rewriteWithModel({
          prompt: original,
          probe,
          cwd: ctx.cwd,
          env,
          timeoutMs: rewriteTimeoutMs,
          fetchImpl,
          modelRegistry: ctx.modelRegistry,
        });
        candidate = rewrite.text;
        filesRead = rewrite.filesRead;
        usedModel = rewrite.model;
        subscription = rewrite.subscription;
      } catch (error) {
        rewriteError = errorText(error);
      }

      const validation = validateCandidate(original, candidate);
      if (!validation.ok) rewriteError = rewriteError || validation.reason;

      let placed = original;
      let action = "original-fallback";
      let intentProbability: number | null = null;
      let intentError: string | null = null;
      let message = rewriteError
        ? `Prompt improvement failed (${rewriteError}); original is in the input box.`
        : "No improvement suggested; original is in the input box.";

      if (validation.ok && validation.changed) {
        try {
          const result = await ask({
            state: {
              original_prompt: original,
              rewritten_prompt: validation.text,
              repository_probe: { ...probe, files_read: filesRead },
            },
            questions: buildCoachQuestions(),
            signal: AbortSignal.timeout(intentTimeoutMs),
          });
          intentProbability = usableNoul(result?.answers?.intent_preserved);
        } catch (error) {
          intentError = errorText(error);
        }
        if (intentProbability !== null && intentProbability >= intentThreshold) {
          placed = validation.text;
          action = "rewritten";
          message = "Improved prompt is in the input box: edit it and press Enter.";
        } else {
          const why = intentError
            ? `the TypeSafe intent check could not run (${intentError})`
            : intentProbability === null
              ? "the TypeSafe intent check gave no usable answer"
              : `the TypeSafe intent check scored it ${intentProbability.toFixed(2)}, below the ${intentThreshold.toFixed(2)} threshold`;
          message = `Rewrite not used: ${why}; original is in the input box.`;
          if (await confirmRejected(ctx, original, validation.text, why)) {
            placed = validation.text;
            action = "rewritten-confirmed";
            message = `Rewrite used at your confirmation (${why}): edit it and press Enter.`;
          } else if (ctx.hasUI && ctx.ui?.confirm) {
            action = "kept-original";
          }
        }
      } else if (validation.ok && !rewriteError) {
        action = "unchanged";
        message = `No change: ${usedModel ?? "the model"} returned your prompt as written (it judged it already clear, or ignored the rewrite instructions); original is in the input box.`;
      }

      record({
        original,
        candidate: validation.ok ? validation.text : null,
        placed,
        action,
        intentProbability,
        intentError,
        rewriteError,
        filesRead,
        probe,
        model: usedModel,
        subscription,
      });

      const usedRewrite = action === "rewritten" || action === "rewritten-confirmed";
      const level = usedRewrite ? "info" : "warning";
      if (place(ctx, placed)) {
        setStatus(ctx, `prompt-coach: ${usedRewrite ? "rewrite ready" : "original kept"}`);
        notify(ctx, message, level);
      } else {
        setStatus(ctx, "prompt-coach: no input box");
        notify(ctx, `No input box to fill. ${placed}`, "warning");
      }
    },
  });
}
