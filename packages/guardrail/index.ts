// index.ts — pi extension: the destructive-action guardrail.
//
// Sits on tool_call, before anything runs, and answers three ways:
//
//   allow    — say nothing; 97-98% of real calls never reach a human
//   confirm  — the dialog: Approve / Deny / Suggest an alternative
//   block    — refused with a reason, no dialog, for the catastrophic set
//
// The cheap half (policy.mjs) decides from the shape of the call and the
// class of its targets. Only the ambiguous band goes to TypeSafe (judge.mjs),
// and only the *judged* band shows calibrated numbers in the dialog — a
// recommendation is offered when the judgment is clear and withheld when it
// is not, because a recommendation people learn to click is not a guardrail.
//
// Escape hatches, in order of blast radius: the deny button, `/guardrail off`
// for the session, and PI_GUARDRAIL=off for a whole process.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { createDialogQueue } from "../../shared/dialog-queue.mjs";
import { evaluateToolCall } from "./policy.mjs";
import {
  DEFAULT_TIMEOUT_MS,
  extractUserRequest,
  judgeToolCall,
  recommendedAction,
} from "./judge.mjs";

const COMMAND = "guardrail";
const SCRIPT_READ_LIMIT = 64 * 1024;
const MAX_SCRIPTS = 5;
const MAX_ACTION_CHARS = 300;

const APPROVE = "✅ Approve";
const DENY = "⛔ Deny";
const SUGGEST = "✏️ Suggest an alternative";

function disabledByEnv(env = process.env) {
  const value = String(env?.PI_GUARDRAIL ?? "")
    .trim()
    .toLowerCase();
  return value === "off" || value === "0" || value === "false";
}

function timeoutMs(env = process.env) {
  const value = Number(env?.PI_GUARDRAIL_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

/** One-line rendering of what is about to run. */
function describeAction(toolName, input) {
  const name = String(toolName ?? "tool");
  const raw =
    typeof input?.command === "string"
      ? input.command
      : typeof input?.path === "string"
        ? input.path
        : (JSON.stringify(input ?? {}) ?? "");
  return `${name}: ${String(raw).replace(/\s+/g, " ").trim().slice(0, MAX_ACTION_CHARS)}`;
}

/**
 * Read the scripts a command would execute, bounded, so the policy can
 * classify their contents. Anything unreadable is reported as unresolved —
 * unread code is judged, never waved through.
 */
function readScriptRefs(refs, cwd) {
  const scriptTexts: Record<string, string> = {};
  const unresolved: string[] = [];
  for (const ref of (Array.isArray(refs) ? refs : []).slice(0, MAX_SCRIPTS)) {
    try {
      const full = isAbsolute(ref) ? ref : resolve(cwd ?? process.cwd(), ref);
      const stats = statSync(full);
      if (!stats.isFile() || stats.size > SCRIPT_READ_LIMIT) {
        unresolved.push(ref);
        continue;
      }
      scriptTexts[ref] = readFileSync(full, "utf8");
    } catch {
      unresolved.push(ref);
    }
  }
  return { scriptTexts, unresolved };
}

export default function piGuardrailExtension(pi: ExtensionAPI) {
  const enqueueDialog = createDialogQueue();
  const state = {
    enabled: !disabledByEnv(),
    judged: 0,
    confirmed: 0,
    blocked: 0,
    allowed: 0,
  };

  const notify = (ctx: ExtensionContext, text: string, level = "info") => {
    try {
      ctx?.ui?.notify?.(text, level);
    } catch {
      // A missing or unhappy UI must never turn into a failed tool call.
    }
  };

  pi.on("tool_call", async (event, ctx) => {
    if (!state.enabled) return undefined;

    const toolName = String(event?.toolName ?? "");
    const input = event?.input ?? {};
    const cwd = ctx?.cwd ?? process.cwd();

    let decision = evaluateToolCall({ toolName, input, cwd });

    // Follow one level of indirection: classify the scripts the command runs.
    const refs = decision?.evidence?.scriptRefs ?? [];
    if (refs.length) {
      const { scriptTexts, unresolved } = readScriptRefs(refs, cwd);
      decision = evaluateToolCall({
        toolName,
        input,
        cwd,
        scriptTexts,
        unresolvedScripts: unresolved,
      });
    }

    const verdict = decision?.verdict ?? "allow";
    if (verdict === "allow") {
      state.allowed += 1;
      return undefined;
    }

    const hasUI = ctx?.hasUI === true;
    // Pull the dialog methods out where they can be checked once: a guardrail
    // that reaches for a missing UI mid-prompt would fail the tool call.
    const ask = (() => {
      const ui = ctx?.ui;
      if (!hasUI || typeof ui?.select !== "function" || typeof ui?.input !== "function")
        return null;
      return { select: ui.select, input: ui.input };
    })();
    let finalVerdict = verdict;
    let reason = decision?.reason ?? "flagged by the guardrail";
    let signals = null;

    if (verdict === "judge") {
      const branch = (() => {
        try {
          return ctx?.sessionManager?.getBranch?.() ?? null;
        } catch {
          return null;
        }
      })();
      const judged = await judgeToolCall({
        action: typeof input?.command === "string" ? input.command : JSON.stringify(input ?? {}),
        toolName,
        cwd,
        userRequest: extractUserRequest(branch),
        policyReason: decision?.reason ?? null,
        // No UI means no human to ask, so the fallback has to be the refusal.
        fallbackVerdict: hasUI ? "confirm" : "block",
        timeoutMs: timeoutMs(),
      });
      state.judged += 1;
      finalVerdict = judged.verdict ?? "confirm";
      reason = judged.reason ?? reason;
      signals = judged.signals ?? null;
    }

    if (finalVerdict === "allow") {
      state.allowed += 1;
      return undefined;
    }

    if (finalVerdict === "block") {
      state.blocked += 1;
      notify(ctx, `🛑 Guardrail refused — ${reason}`, "warning");
      return {
        block: true,
        reason: `The guardrail refused this call (${reason}). Do not retry it as-is. If it is genuinely needed, say so and ask the user to approve it explicitly, or to run \`/guardrail off\` for the session.`,
      };
    }

    state.confirmed += 1;
    if (!ask) {
      state.blocked += 1;
      notify(ctx, `🛑 Guardrail blocked (no UI to ask) — ${reason}`, "warning");
      return {
        block: true,
        reason: `The guardrail needs the user to approve this call, and there is no interactive UI (${reason}). Ask the user to run it, or to re-run with approval.`,
      };
    }

    const recommended = signals ? recommendedAction(signals) : null;
    const title = [
      "🛑 Guardrail",
      describeAction(toolName, input),
      reason,
      recommended ? `➡️ Recommended: ${recommended}` : "",
    ]
      .filter((part) => part.length > 0)
      .join("\n\n");

    let choice;
    try {
      choice = await enqueueDialog(() => ask.select(title, [APPROVE, DENY, SUGGEST]));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notify(ctx, `🛑 Guardrail dialog failed — ${message}`, "error");
      return {
        block: true,
        reason: `The guardrail could not ask for approval (${message}), so the call was refused.`,
      };
    }

    if (choice === APPROVE) {
      notify(ctx, `Guardrail: approved — ${describeAction(toolName, input)}`, "info");
      return undefined;
    }

    if (choice === SUGGEST) {
      let alternative = "";
      try {
        alternative = String(
          (await enqueueDialog(() =>
            ask.input("What should it do instead?", "Describe the safer version"),
          )) ?? "",
        ).trim();
      } catch {
        alternative = "";
      }
      state.blocked += 1;
      const suggestion = alternative
        ? `The user suggests this instead: ${alternative}`
        : "The user chose not to describe an alternative.";
      return {
        block: true,
        reason: `Refused by the user (${reason}). ${suggestion} Do not run the original call; follow the suggestion if it is actionable, otherwise ask one short question.`,
      };
    }

    state.blocked += 1;
    return {
      block: true,
      reason: `Refused by the user (${reason}). Do not retry it as-is — ask what they would prefer instead.`,
    };
  });

  pi.registerCommand(COMMAND, {
    description: "Show or toggle the destructive-action guardrail for this session",
    handler: async (args, ctx) => {
      const action = String(args ?? "")
        .trim()
        .toLowerCase();
      if (action === "off" || action === "disable") {
        state.enabled = false;
        notify(ctx, "Guardrail off for this session. /guardrail on to re-arm.", "warning");
        return;
      }
      if (action === "on" || action === "enable") {
        state.enabled = true;
        notify(ctx, "Guardrail on.", "info");
        return;
      }
      const status = [
        `Guardrail ${state.enabled ? "on" : "OFF"} (PI_GUARDRAIL=${state.enabled ? "unset" : "off"})`,
        `this session: ${state.allowed} allowed · ${state.confirmed} asked · ${state.blocked} refused · ${state.judged} judged`,
        `judge timeout ${timeoutMs()}ms; /guardrail on|off`,
      ].join("\n");
      notify(ctx, status, "info");
    },
  });
}
