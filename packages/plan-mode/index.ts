// plan-mode.ts — read-only /plan collaboration mode for pi.
//
// Lazy edition of @narumirw/pi-plan-mode: no menus, exports, fresh-session
// handoff, retention policies, or settings file. The workflow:
//
//   /plan <prompt>       -> enter plan mode and submit <prompt>
//   /plan approve        -> approve the plan: leaves plan mode and kicks off
//                           implementation from the plan file
//   /plan status         -> show state and the current plan file path
//   /plan exit | off     -> cancel plan mode without implementing
//
// While active, the model explores read-only and finishes with
// plan_mode_complete({ plan }). The plan is written to PLAN.md in the current
// working directory — you read/edit it, then /plan approve ends plan mode and
// starts implementation from that file. The file is the durable artifact: it
// survives compaction and is the implementation handoff, so plan mode never
// needs in-memory retention.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { blockedBashCommand } from "./bash-policy.mjs";

const QUESTION_TOOL = "plan_mode_question";
const COMPLETE_TOOL = "plan_mode_complete";
const PLAN_TOOLS = ["read", "bash", QUESTION_TOOL, COMPLETE_TOOL];
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
const PLAN_FILENAME = "PLAN.md";
const MAX_PLAN_CHARS = 50000;

const PLAN_MODE_PROMPT = `# Plan Mode (read-only)

You are in Plan Mode, a Codex-like collaboration mode for producing a decision-complete implementation plan. Chat your way to the plan before finalizing it. A final plan must leave no implementation decisions unresolved.

## Mode rules

- Stay in Plan Mode until the user exits it. Treat requests to implement as requests to plan the implementation; do not edit files or carry out the plan.
- Do not use update_plan/TODO tooling; Plan Mode is conversational planning, not execution tracking.
- Do not perform mutating actions: no edit/write tools, no patching, no dependency installation, no commits, no migrations. Bash is restricted to read-only inspection by policy — do not attempt workarounds.

## Phase 1 — Ground in the environment

- Explore first and ask second. Use non-mutating exploration to read files, search, inspect configuration, and resolve discoverable facts.
- Do not ask questions that can be answered from repository or system truth. Ask only when multiple plausible choices remain, a needed identifier/context is missing, or the ambiguity is product intent.

## Phase 2 — Intent chat

- Keep asking until you can clearly state the goal, success criteria, in/out of scope, constraints, current state, and key preferences/tradeoffs.
- Bias toward questions over guessing: if a high-impact ambiguity remains, do not produce a proposed plan yet.
- For an unanswered preference or tradeoff, use the recommended option only when it is low risk and record that default as an explicit assumption in the final plan.

## Phase 3 — Implementation chat

- Once intent is stable, keep asking until the spec is decision-complete: approach, interfaces, data flow, edge cases/failure modes, testing and acceptance criteria, and any migration or compatibility constraints.
- Use plan_mode_question for important preferences, tradeoffs, or assumption locks that cannot be discovered by exploration. Ask 1-3 concise questions with 2-4 meaningful options.
- If plan_mode_question is cancelled or UI is unavailable, ask one concise plain-text question instead, or proceed only with a clearly stated low-risk assumption.

## Ending each turn

- If a material decision remains, use plan_mode_question (or ask in plain text when UI is unavailable).
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

  function notify(ctx: { hasUI?: boolean; ui?: { notify: (t: string, l?: string) => void } }, message: string) {
    if (ctx.hasUI) ctx.ui?.notify(message, "info");
  }

  function enterPlanMode(ctx: { hasUI?: boolean; ui?: { notify: (t: string, l?: string) => void } }) {
    if (state.enabled) return;
    try {
      state.previousTools = pi.getActiveTools();
    } catch {
      state.previousTools = null;
    }
    state.enabled = true;
    pi.setActiveTools(PLAN_TOOLS);
    notify(ctx, "Plan mode active — read-only. /plan exit to leave.");
  }

  function exitPlanMode(
    ctx: { hasUI?: boolean; ui?: { notify: (t: string, l?: string) => void } },
    message?: string,
  ) {
    if (!state.enabled) return;
    state.enabled = false;
    pi.setActiveTools(state.previousTools ?? DEFAULT_TOOLS);
    state.previousTools = null;
    notify(
      ctx,
      message ??
        (state.planPath
          ? `Plan mode off — tools restored. Plan file: ${state.planPath}.`
          : "Plan mode off — tools restored."),
    );
  }

  async function writePlanFile(
    ctx: { cwd?: string },
    plan: string,
  ): Promise<string> {
    const dir = ctx.cwd ?? process.cwd();
    const target = path.join(dir, PLAN_FILENAME);
    let existing: string | null = null;
    try {
      existing = await readFile(target, "utf8");
    } catch {
      existing = null;
    }
    if (existing !== null && existing !== lastWritten) {
      // The file exists and differs from what we last wrote — the user (or
      // something else) changed it. Never clobber: pick PLAN.md.2, PLAN.md.3, …
      let n = 2;
      while (existsSync(`${target}.${n}`)) n++;
      const alt = `${target}.${n}`;
      await writeFile(alt, plan, "utf8");
      state.planPath = alt;
      lastWritten = plan;
      return alt;
    }
    await writeFile(target, plan, "utf8");
    state.planPath = target;
    lastWritten = plan;
    return target;
  }

  // --- Command -------------------------------------------------------------

  pi.registerCommand("plan", {
    description: "Plan mode: <prompt> | approve | status | exit",
    handler: async (args, ctx) => {
      const arg = (args ?? "").trim();
      if (arg === "status" || arg === "") {
        notify(
          ctx,
          state.enabled
            ? `Plan mode: active — read-only (tools: ${PLAN_TOOLS.join(", ")}).${state.planPath ? `\nPlan file: ${state.planPath}` : ""}`
            : `Plan mode: off.${state.planPath ? `\nPlan file: ${state.planPath} (edit it, then /plan approve to implement)` : ""}\nusage: /plan <prompt> | approve | status | exit`,
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
        const path = state.planPath;
        exitPlanMode(ctx, `Plan approved — leaving plan mode. Implementing from ${path}.`);
        await pi.sendUserMessage(`The plan is approved. Read ${path} and implement it exactly as written.`, {
          deliverAs: "followUp",
        });
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

  // --- Prompt injection + tool enforcement ----------------------------------

  pi.on("before_agent_start", (event) => {
    if (!state.enabled) return;
    pi.setActiveTools(PLAN_TOOLS);
    return { systemPrompt: `${event.systemPrompt}\n\n${PLAN_MODE_PROMPT}` };
  });

  // --- Tool-call blocking ----------------------------------------------------

  pi.on("tool_call", (event) => {
    if (!state.enabled) return;
    if (event.toolName === "edit" || event.toolName === "write" || event.toolName === "update_plan") {
      return { block: true, reason: `Plan mode blocks ${event.toolName} — read-only planning.` };
    }
    if (event.toolName === "bash") {
      const command = typeof event.input?.command === "string" ? event.input.command : "";
      const blocked = blockedBashCommand(command);
      if (blocked) {
        return { block: true, reason: `Plan mode blocks mutating bash command: ${blocked}` };
      }
    }
  });

  // --- Tools ----------------------------------------------------------------

  pi.registerTool({
    name: QUESTION_TOOL,
    label: "Plan Mode Question",
    description:
      "Ask the user a decision question with 2-4 meaningful options before finalizing the plan. " +
      "Use only for preferences, tradeoffs, or assumption locks that cannot be discovered by read-only exploration.",
    parameters: Type.Object({
      question: Type.String({ description: "The question to ask" }),
      options: Type.Array(Type.String(), { description: "2-4 meaningful options; the user may also type their own" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const question = String(params?.question ?? "").trim();
      const options = Array.isArray(params?.options) ? params.options.map(String) : [];
      if (!question) {
        return { content: [{ type: "text", text: "Rejected: question is empty." }] };
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
        const choice = await ctx.ui.select(question, options);
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
      notify(ctx, `Plan saved to ${savedPath} — review and edit it, then /plan approve to start implementation.`);
      return {
        content: [
          {
            type: "text",
            text: `Plan accepted and written to ${savedPath}. The user will review or edit it and approve with /plan approve — stay in plan mode until then. Accepted plan:\n\n${plan}`,
          },
        ],
        terminate: true,
      };
    },
  });
}
