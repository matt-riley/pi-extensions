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
import { readFileSync, statSync, realpathSync, lstatSync, readlinkSync } from "node:fs";
import { isAbsolute, resolve, dirname, basename, join } from "node:path";

import { OWNED_TOOL_NAMES } from "../../shared/tool-annotations.mjs";
import { flagOff } from "../../shared/env-flag.mjs";
import { createDialogQueue } from "../../shared/dialog-queue.mjs";
import { bindSystemOne } from "../../shared/systemone-session.mjs";
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
  if (name === "terminal_send") return `${name}: ${raw}`; // Show every byte being approved.
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

// Resolve the nearest existing ancestor too: a new file can be written through
// a symlinked parent. A dangling symlink still names its target, so follow it
// rather than letting a write through the link escape the control-plane check.
// This is identity for approval scope, not a filesystem lock.
function canonicalPath(path: string, seen = new Set<string>()): string {
  if (seen.has(path)) return path;
  seen.add(path);
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    if (parent === path) return path;
    const resolvedParent = canonicalPath(parent, seen);
    try {
      if (lstatSync(path).isSymbolicLink()) {
        const target = readlinkSync(path);
        return canonicalPath(isAbsolute(target) ? target : join(resolvedParent, target), seen);
      }
    } catch {
      // Not there yet: a new file, not a link.
    }
    return join(resolvedParent, basename(path));
  }
}

export default function piGuardrailExtension(pi: ExtensionAPI) {
  bindSystemOne(pi);
  const enqueueDialog = createDialogQueue();
  const approvals = new Set<string>();
  let generation = 0;
  const revoke = () => {
    generation++;
    approvals.clear();
  };
  pi.on("input", revoke);
  // A switch replaces the runtime, which fires session_start again.
  pi.on("session_start", revoke);
  const state = {
    enabled: !flagOff(process.env?.PI_GUARDRAIL),
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

  // Annotations decide trust, so a registry that throws must not decide policy:
  // pi's ctx getters throw after /new, and an escaped throw would skip the gate.
  const registeredTool = (toolName: string) => {
    try {
      const tools = typeof pi.getAllTools === "function" ? pi.getAllTools() : [];
      return tools.find((tool) => tool.name === toolName);
    } catch {
      return undefined;
    }
  };

  pi.on("tool_call", async (event, ctx) => {
    if (!state.enabled) return undefined;

    const toolName = String(event?.toolName ?? "");
    const input = event?.input ?? {};
    const cwd = canonicalPath(ctx?.cwd ?? process.cwd());
    const epoch = generation;
    const tool = registeredTool(toolName);
    const options = {
      toolName,
      input,
      cwd,
      resolvePath: canonicalPath,
      external: Boolean(
        (tool?.namespace && !OWNED_TOOL_NAMES.has(toolName)) ||
        /^(mcp__|cloudflare_mcp_)/.test(toolName),
      ),
      annotations: tool?.annotations,
    };
    let decision = evaluateToolCall(options);

    // Follow one level of indirection: classify the scripts the command runs.
    const refs = decision?.evidence?.scriptRefs ?? [];
    if (refs.length) {
      const { scriptTexts, unresolved } = readScriptRefs(refs, cwd);
      decision = evaluateToolCall({
        ...options,
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

    const scopes: string[] = [...new Set<string>(decision?.evidence?.approvalScopes ?? [])];
    // Shell scopes include the entire invocation, so approving a push cannot
    // bless a newly appended command. File edits intentionally cover that file.
    const scopeKey =
      toolName !== "terminal_send" && scopes.length
        ? JSON.stringify([
            cwd,
            scopes.sort(),
            toolName === "bash"
              ? input.command
              : scopes.every((scope) => scope.startsWith("control:"))
                ? null
                : [toolName, input],
          ])
        : null;
    if (scopeKey && approvals.has(scopeKey)) {
      state.allowed += 1;
      return undefined;
    }

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
      scopeKey
        ? `Approval scope (current input only):\n${scopes.join("\n")}\nRepository/cwd: ${cwd}`
        : "",
      recommended ? `➡️ Recommended: ${recommended}` : "",
    ]
      .filter((part) => part.length > 0)
      .join("\n\n");

    let choice;
    try {
      choice = await enqueueDialog(async () => {
        if (epoch !== generation) return DENY;
        if (scopeKey && approvals.has(scopeKey)) return APPROVE;
        state.confirmed += 1;
        const selected = await ask.select(title, [APPROVE, DENY, SUGGEST]);
        if (epoch !== generation) return DENY;
        if (selected === APPROVE && scopeKey) approvals.add(scopeKey);
        return selected;
      });
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
      if (action === "revoke") {
        revoke();
        notify(ctx, "Guardrail approvals revoked.", "info");
        return;
      }
      if (action === "off" || action === "disable") {
        revoke();
        state.enabled = false;
        notify(ctx, "Guardrail off for this session. /guardrail on to re-arm.", "warning");
        return;
      }
      if (action === "on" || action === "enable") {
        revoke();
        state.enabled = true;
        notify(ctx, "Guardrail on.", "info");
        return;
      }
      const status = [
        `Guardrail ${state.enabled ? "on" : "OFF"} (PI_GUARDRAIL=${state.enabled ? "unset" : "off"})`,
        `this session: ${state.allowed} allowed · ${state.confirmed} asked · ${state.blocked} refused · ${state.judged} judged`,
        `judge timeout ${timeoutMs()}ms; ${approvals.size} current-input approvals; /guardrail on|off|revoke`,
      ].join("\n");
      notify(ctx, status, "info");
    },
  });
}
