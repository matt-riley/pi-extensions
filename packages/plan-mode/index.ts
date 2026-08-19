// plan-mode.ts — read-only /plan collaboration mode for pi.
//
// Lazy edition of @narumirw/pi-plan-mode: no menus, exports, fresh-session
// handoff, retention policies, or settings file. The workflow:
//
//   /plan <prompt>       -> enter plan mode and submit <prompt>
//   /plan approve        -> approve the plan: leaves plan mode and kicks off
//                           implementation from the plan file
//   /plan status         -> show state and the current plan file path
//   /plan edit           -> edit the plan in the editor dialog (Ctrl+G hands
//                           off to $EDITOR, then the plan is written back)
//   /plan exit | off     -> cancel plan mode without implementing
//   ctrl+alt+p           -> toggle plan mode
//   ctrl+alt+e           -> edit the plan (same as /plan edit)
//   --plan               -> start pi already in plan mode
//
// While active, the model explores read-only and finishes with
// plan_mode_complete({ plan }). The plan is written to PLAN.md in the current
// working directory — you read/edit it, then /plan approve ends plan mode and
// starts implementation from that file. The file is the durable artifact: it
// survives compaction and is the implementation handoff, so plan mode never
// needs in-memory retention. A footer status and a widget show the state.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { blockedBashCommand } from "./bash-policy.mjs";
import { atomicWriteFile, resolvePlanFile } from "./plan-file.mjs";

const QUESTION_TOOL = "plan_mode_question";
const COMPLETE_TOOL = "plan_mode_complete";
// grep/find/ls are read-only built-ins, included like the reference plan-mode
// example's toolset.
const PLAN_TOOLS = ["read", "bash", "grep", "find", "ls", QUESTION_TOOL, COMPLETE_TOOL];
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
const PLAN_FILENAME = "PLAN.md";
const MAX_PLAN_CHARS = 50000;

const PLAN_MODE_PROMPT = `# Plan Mode (read-only)

You are in Plan Mode, a Codex-like collaboration mode for producing a decision-complete implementation plan. Chat your way to the plan before finalizing it. Grill the user for the full scope first: a plan is written only once every decision is settled and understood by both of you. A final plan must leave no implementation decisions unresolved.

## Mode rules

- Stay in Plan Mode until the user exits it. Treat requests to implement as requests to plan the implementation; do not edit files or carry out the plan.
- Do not use update_plan/TODO tooling; Plan Mode is conversational planning, not execution tracking.
- Do not perform mutating actions: no edit/write tools, no patching, no dependency installation, no commits, no migrations. Bash is restricted to a fail-closed allowlist of read-only commands (ls, cat, rg, find, git log/status/diff, npm ls, …) — test runners, script interpreters, installs, and network tools are blocked; do not attempt workarounds.

## Phase 1 — Ground in the environment

- Explore first and ask second. Use non-mutating exploration to read files, search, inspect configuration, and resolve discoverable facts.
- Do not ask questions that can be answered from repository or system truth. Ask only when multiple plausible choices remain, a needed identifier/context is missing, or the ambiguity is product intent.

## Phase 2 — Grill: scope & intent

Work the request as a design tree: every decision branches into the decisions that hang off it. The frontier is every decision whose prerequisites are already settled — the questions you can ask now without guessing at answers you haven't heard yet.

- Grill in rounds. Ask the whole frontier in one round: number each question, give 2-4 meaningful options where they exist, and give your recommended answer for each. Use plan_mode_question (with title and recommended) when UI is available; otherwise ask in plain text.
- Wait for the user's answers before the next round. Answers reshape the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open this round belongs to a later round, not this one.
- Finding facts is your job, never the user's: never ask for anything read-only exploration can look up (files, config, identifiers). Only decisions go to the user.
- Keep grilling until you can state the goal, success criteria, in/out of scope, constraints, current state, and key preferences/tradeoffs without guessing. Bias toward questions over guessing: if a high-impact ambiguity remains, do not produce a proposed plan yet.
- For an unanswered preference or tradeoff, use the recommended option only when it is low risk and record that default as an explicit assumption in the final plan.

## Phase 3 — Grill: implementation spec

- Once intent is stable, keep grilling until the spec is decision-complete: approach, interfaces, data flow, edge cases/failure modes, testing and acceptance criteria, and any migration or compatibility constraints. Same round mechanics — numbered frontier questions with options and recommended answers — now over implementation decisions.
- If plan_mode_question is cancelled or UI is unavailable, ask one concise plain-text question instead, or proceed only with a clearly stated low-risk assumption.

## Ending each turn

- If the grill frontier is not empty — a material decision remains — keep grilling with plan_mode_question (or plain text when UI is unavailable). Do not finalize.
- If the implementation plan is decision-complete, call plan_mode_complete alone as your final action, passing the complete Markdown plan. Do not call other tools in the same batch and do not emit a normal assistant response after it.
- Never end with prose that merely announces you are about to present the plan. Submit the actual plan with plan_mode_complete in that turn.

## The plan document

Only call plan_mode_complete when the plan leaves no implementation decisions unresolved. The plan is written to a file for the user to review and edit before implementation, so write it as a standalone Markdown document with:

- A clear title
- A brief summary
- Important changes to behavior, public APIs, interfaces, or types
- Test cases and verification scenarios
- Explicit assumptions and defaults chosen where needed

Keep it concise, human and agent digestible, and free of open decisions. If the user requests revisions, the next plan_mode_complete call must contain a complete replacement, not a delta. Once the plan is written, stay in plan mode until the user approves it with /plan approve — plan mode then ends and implementation begins from that file. Revisions are still planned, never implemented.`;

// Minimal structural context used by helpers; real ExtensionContext/command
// contexts satisfy it.
interface UiCtx {
  hasUI?: boolean;
  cwd?: string;
  ui?: {
    notify?: (title: string, level?: string) => void;
    setStatus?: (id: string, text: string | undefined) => void;
    setWidget?: (id: string, lines: string[] | undefined) => void;
    editor?: (title: string, prefill?: string) => Promise<string | undefined>;
    theme?: { fg?: (color: string, text: string) => string };
  };
}

interface PlanModeState {
  enabled: boolean;
  previousTools: string[] | null;
  planPath: string | null;
}

export default function planMode(pi: ExtensionAPI) {
  const state: PlanModeState = { enabled: false, previousTools: null, planPath: null };
  // Content we last wrote to planPath, so revisions can overwrite in place
  // while user edits are never clobbered.
  let lastWritten: string | null = null;

  function notify(ctx: UiCtx, message: string) {
    if (ctx.hasUI) ctx.ui?.notify?.(message, "info");
  }

  function updateStatus(ctx: UiCtx) {
    if (!ctx.hasUI || !ctx.ui) return;
    if (state.enabled) {
      const label =
        ctx.ui.theme?.fg != null ? ctx.ui.theme.fg("warning", "plan (read-only)") : "plan (read-only)";
      ctx.ui.setStatus?.("plan-mode", label);
      ctx.ui.setWidget?.("plan-mode", [
        "Plan mode: active — read-only",
        state.planPath
          ? `Plan file: ${state.planPath} — /plan approve to implement`
          : "No plan yet — /plan <prompt> to start",
      ]);
    } else {
      ctx.ui.setStatus?.("plan-mode", undefined);
      ctx.ui.setWidget?.("plan-mode", undefined);
    }
  }

  function enterPlanMode(ctx: UiCtx) {
    if (state.enabled) return;
    try {
      state.previousTools = pi.getActiveTools();
    } catch {
      state.previousTools = null;
    }
    state.enabled = true;
    pi.setActiveTools(PLAN_TOOLS);
    updateStatus(ctx);
    notify(ctx, "Plan mode active — read-only. /plan exit to leave.");
  }

  function exitPlanMode(ctx: UiCtx, message?: string) {
    if (!state.enabled) return;
    state.enabled = false;
    pi.setActiveTools(state.previousTools ?? DEFAULT_TOOLS);
    state.previousTools = null;
    updateStatus(ctx);
    notify(
      ctx,
      message ??
        (state.planPath
          ? `Plan mode off — tools restored. Plan file: ${state.planPath}.`
          : "Plan mode off — tools restored."),
    );
  }

  async function writePlanFile(ctx: UiCtx, plan: string): Promise<string> {
    const dir = ctx.cwd ?? process.cwd();
    const base = path.join(dir, PLAN_FILENAME);
    let existing: string | null = null;
    try {
      existing = await readFile(base, "utf8");
    } catch {
      existing = null;
    }
    const chosen = resolvePlanFile({
      base,
      plan,
      existing,
      lastWritten,
      altTaken: (n) => existsSync(`${base}.${n}`),
    });
    await atomicWriteFile(chosen, plan);
    state.planPath = chosen;
    lastWritten = plan;
    return chosen;
  }

  async function editPlanFile(ctx: UiCtx) {
    if (!state.planPath) {
      notify(ctx, "No plan file to edit yet — finish planning first.");
      return;
    }
    if (!existsSync(state.planPath)) {
      notify(ctx, `Plan file missing (${state.planPath}) — re-plan or restore it first.`);
      return;
    }
    if (!ctx.hasUI || !ctx.ui?.editor) {
      notify(ctx, "No interactive editor available in this mode — edit the plan file directly.");
      return;
    }
    let current: string;
    try {
      current = await readFile(state.planPath, "utf8");
    } catch (error) {
      notify(ctx, `Failed to read ${state.planPath}: ${(error as Error).message}`);
      return;
    }
    const edited = await ctx.ui.editor("Edit plan — Ctrl+G opens $EDITOR:", current);
    if (edited === undefined || edited === null) {
      notify(ctx, "Edit cancelled — plan unchanged.");
      return;
    }
    if (edited === current) {
      notify(ctx, "No changes — plan unchanged.");
      return;
    }
    try {
      await atomicWriteFile(state.planPath, edited);
    } catch (error) {
      notify(ctx, `Failed to write ${state.planPath}: ${(error as Error).message}`);
      return;
    }
    lastWritten = edited;
    updateStatus(ctx);
    notify(ctx, `Plan updated — ${state.planPath}.`);
  }

  // --- Command -------------------------------------------------------------

  pi.registerCommand("plan", {
    description: "Plan mode: <prompt> | approve | status | edit | exit",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim();
      if (arg === "status" || arg === "") {
        notify(
          ctx,
          state.enabled
            ? `Plan mode: active — read-only (tools: ${PLAN_TOOLS.join(", ")}).${state.planPath ? `\nPlan file: ${state.planPath}` : ""}`
            : `Plan mode: off.${state.planPath ? `\nPlan file: ${state.planPath} (edit it, then /plan approve to implement)` : ""}\nusage: /plan <prompt> | approve | status | edit | exit`,
        );
        return;
      }
      if (arg === "start") {
        enterPlanMode(ctx);
        return;
      }
      if (arg === "approve") {
        if (!state.planPath) {
          notify(ctx, "No plan to approve yet — finish planning first (the agent calls plan_mode_complete).");
          return;
        }
        const planFile = state.planPath;
        if (!existsSync(planFile)) {
          notify(ctx, `Plan file missing (${planFile}) — re-plan or restore it first.`);
          return;
        }
        exitPlanMode(ctx, `Plan approved — leaving plan mode. Implementing from ${planFile}.`);
        await pi.sendUserMessage(`The plan is approved. Read ${planFile} and implement it exactly as written.`, {
          deliverAs: "followUp",
        });
        state.planPath = null;
        lastWritten = null;
        return;
      }
      if (arg === "edit") {
        await editPlanFile(ctx);
        return;
      }
      if (arg === "exit" || arg === "off") {
        exitPlanMode(ctx, "Plan mode cancelled — tools restored.");
        return;
      }
      // /plan <prompt>: enter plan mode and submit the prompt.
      enterPlanMode(ctx);
      await pi.sendUserMessage(arg, { deliverAs: "followUp" });
    },
  });

  // --- Flag, shortcuts, session start --------------------------------------

  pi.registerFlag("plan", {
    description: "Start in plan mode (read-only)",
    type: "boolean",
    default: false,
  });

  pi.registerShortcut("ctrl+alt+p", {
    description: "Toggle plan mode",
    handler: (ctx) => (state.enabled ? exitPlanMode(ctx) : enterPlanMode(ctx)),
  });

  pi.registerShortcut("ctrl+alt+e", {
    description: "Edit plan in external editor",
    handler: async (ctx) => {
      await editPlanFile(ctx);
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (pi.getFlag("plan") && !state.enabled) enterPlanMode(ctx);
  });

  // --- Prompt injection + tool enforcement ----------------------------------

  pi.on("before_agent_start", (event) => {
    if (!state.enabled) return;
    pi.setActiveTools(PLAN_TOOLS);
    return { systemPrompt: `${event.systemPrompt}\n\n${PLAN_MODE_PROMPT}` };
  });

  // --- Tool-call blocking ----------------------------------------------------

  pi.on("tool_call", (event) => {
    if (!state.enabled) return;
    // Strict allowlist: plan mode permits only the plan toolset, so a stale or
    // out-of-band tool call (grep/find/ls built-ins, other extensions' tools,
    // edit/write/update_plan) never executes.
    if (!PLAN_TOOLS.includes(event.toolName)) {
      return { block: true, reason: `Plan mode blocks ${event.toolName} — read-only planning.` };
    }
    if (event.toolName === "bash") {
      const command = typeof event.input?.command === "string" ? event.input.command : "";
      const blocked = blockedBashCommand(command);
      if (blocked) {
        return { block: true, reason: `Plan mode blocks bash command (read-only allowlist): ${blocked}` };
      }
    }
  });

  // --- Tools ----------------------------------------------------------------

  pi.registerTool({
    name: QUESTION_TOOL,
    label: "Plan Mode Question",
    description:
      "Ask the user a decision question with 2-4 meaningful options before finalizing the plan. " +
      "Include a recommended answer when you have a sensible default. " +
      "Use only for preferences, tradeoffs, or assumption locks that cannot be discovered by read-only exploration.",
    parameters: Type.Object({
      title: Type.Optional(Type.String({ description: "Short title for the question (grill format)" })),
      question: Type.String({ description: "The question to ask" }),
      options: Type.Array(Type.String(), { description: "2-4 meaningful options; the user may also type their own" }),
      recommended: Type.Optional(Type.String({ description: "Your recommended answer, shown to the user" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const title = typeof params?.title === "string" ? params.title.trim() : "";
      const question = String(params?.question ?? "").trim();
      const options = Array.isArray(params?.options) ? params.options.map(String) : [];
      const recommended = typeof params?.recommended === "string" ? params.recommended.trim() : "";
      if (!question) {
        return { content: [{ type: "text", text: "Rejected: question is empty." }] };
      }
      if (options.length < 2 || options.length > 4) {
        return {
          content: [
            {
              type: "text",
              text: `Rejected: expected 2-4 options, got ${options.length}. Call plan_mode_question again with 2-4 meaningful options.`,
            },
          ],
        };
      }
      if (!ctx.hasUI || !ctx.ui?.select) {
        return {
          content: [
            {
              type: "text",
              text: "No interactive UI available. Ask the question in plain text and wait for the answer before finalizing.",
            },
          ],
        };
      }
      try {
        const dialogTitle = [
          title ? `❓ ${title}` : "",
          question,
          recommended ? `➡️ Recommended: ${recommended}` : "",
        ]
          .filter((part) => part.length > 0)
          .join("\n\n");
        const choice = await ctx.ui.select(dialogTitle, options);
        if (choice === undefined || choice === null) {
          return {
            content: [
              {
                type: "text",
                text: "Question cancelled by the user. Ask one concise plain-text question, or proceed only with a clearly stated low-risk assumption.",
              },
            ],
          };
        }
        return { content: [{ type: "text", text: `User answered: ${choice}` }] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Question dialog failed (${(error as Error).message}). Ask the question in plain text instead.`,
            },
          ],
        };
      }
    },
  });

  pi.registerTool({
    name: COMPLETE_TOOL,
    label: "Plan Mode Complete",
    description:
      "Submit the complete, decision-final implementation plan as Markdown. Call this alone as your final action — " +
      "the plan is written to a file for the user to review and edit before implementation.",
    parameters: Type.Object({
      plan: Type.String({ description: "Complete implementation plan in Markdown" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!state.enabled) {
        return { content: [{ type: "text", text: "Not in plan mode — plan_mode_complete is inactive." }] };
      }
      const plan = String(params?.plan ?? "").trim();
      if (!plan) {
        return { content: [{ type: "text", text: "Rejected: plan is empty." }] };
      }
      if (plan.length > MAX_PLAN_CHARS) {
        return {
          content: [
            {
              type: "text",
              text: `Rejected: plan is ${plan.length} characters; the limit is ${MAX_PLAN_CHARS}. Shorten it and call plan_mode_complete again.`,
            },
          ],
        };
      }
      let savedPath: string;
      try {
        savedPath = await writePlanFile(ctx, plan);
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `Failed to write the plan file: ${(error as Error).message}. Report this and ask how to proceed.`,
            },
          ],
        };
      }
      updateStatus(ctx);
      notify(ctx, `Plan saved to ${savedPath} — review and edit it, then /plan approve to start implementation.`);
      return {
        content: [
          {
            type: "text",
            text: `Plan accepted and written to ${savedPath}. The user will review or edit it and approve with /plan approve — stay in plan mode until then. Re-read the file if you need to revise it.`,
          },
        ],
        terminate: true,
      };
    },
  });
}
