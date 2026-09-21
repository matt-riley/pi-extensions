// index.ts — on-demand /improve: local rewrite, TypeSafe intent check, submit.
//
// This deliberately does not intercept ordinary input. The user asks for an
// improvement explicitly, Gemma4 writes locally, TypeSafe checks preservation,
// and pi receives exactly one real user message. Any failure sends the original
// prompt instead of silently losing the task.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { askSystemOne } from "../../shared/systemone.mjs";
import { buildQuestions } from "./battery.mjs";
import { extractLastUserPrompt, usableNoul, validateCandidate } from "./lib.mjs";
import { collectProbe } from "./probe.mjs";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  rewriteWithLocalModel,
} from "./rewrite.mjs";

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
  deps: { ask?: typeof askSystemOne; exec?: CoachExec; fetchImpl?: CoachFetch } = {},
) {
  const ask = deps.ask ?? askSystemOne;
  const run: CoachExec = deps.exec ?? ((cmd, args, opts) => pi.exec(cmd, args, opts));
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const intentThreshold = Math.min(
    1,
    Math.max(0, envNumber("PI_PROMPT_COACH_INTENT_THRESHOLD", DEFAULT_INTENT_THRESHOLD)),
  );
  const localTimeoutMs = envNumber("PI_PROMPT_COACH_LOCAL_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const intentTimeoutMs = envNumber("PI_PROMPT_COACH_INTENT_TIMEOUT_MS", DEFAULT_INTENT_TIMEOUT_MS);

  const record = (data: Record<string, unknown>) => {
    try {
      pi.appendEntry?.("prompt-coach-decision", { at: Date.now(), version: 2, ...data });
    } catch {
      // Telemetry must never block the requested task.
    }
  };

  pi.registerCommand(COMMAND, {
    description: "Improve a prompt locally with Gemma4, verify intent, and send it",
    handler: async (args: string, ctx: ExtensionContext) => {
      if (ctx.isIdle && !ctx.isIdle()) {
        notify(ctx, "Prompt improvement waits until the agent is idle.", "warning");
        return;
      }

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
      let rewriteError: string | null = null;

      try {
        candidate = await rewriteWithLocalModel({
          prompt: original,
          probe,
          cwd: ctx.cwd,
          baseUrl: process.env.PI_PROMPT_COACH_BASE_URL || DEFAULT_BASE_URL,
          model: process.env.PI_PROMPT_COACH_MODEL || DEFAULT_MODEL,
          timeoutMs: localTimeoutMs,
          fetchImpl,
        });
      } catch (error) {
        rewriteError = errorText(error);
      }

      const validation = validateCandidate(original, candidate);
      if (!validation.ok) rewriteError = rewriteError || validation.reason;
      if (!validation.ok || !validation.changed) {
        record({
          original,
          candidate: validation.ok ? validation.text : null,
          sent: original,
          action: rewriteError ? "original-fallback" : "unchanged",
          rewriteError,
          probe,
        });
        setStatus(ctx, "prompt-coach: original sent");
        try {
          await pi.sendUserMessage(original);
        } catch (error) {
          notify(ctx, `Could not send the original prompt: ${errorText(error)}`, "error");
        }
        return;
      }

      let intentProbability: number | null = null;
      let intentError: string | null = null;
      try {
        const result = await ask({
          state: {
            original_prompt: original,
            rewritten_prompt: validation.text,
            repository_probe: probe,
          },
          questions: buildQuestions(),
          signal: AbortSignal.timeout(intentTimeoutMs),
        });
        intentProbability = usableNoul(result?.answers?.intent_preserved);
      } catch (error) {
        intentError = errorText(error);
      }

      const accepted = intentProbability !== null && intentProbability >= intentThreshold;
      const sent = accepted ? validation.text : original;
      record({
        original,
        candidate: validation.text,
        sent,
        action: accepted ? "rewritten" : "original-fallback",
        intentProbability,
        intentError,
        rewriteError,
        probe,
      });

      try {
        await pi.sendUserMessage(sent);
        setStatus(
          ctx,
          accepted ? "prompt-coach: improved prompt sent" : "prompt-coach: original sent",
        );
        if (accepted) notify(ctx, "Improved prompt sent.");
        else notify(ctx, "Prompt improvement was not verified; original sent.", "warning");
      } catch (error) {
        setStatus(ctx, "prompt-coach: send failed");
        notify(ctx, `Could not send the prompt: ${errorText(error)}`, "error");
      }
    },
  });
}
