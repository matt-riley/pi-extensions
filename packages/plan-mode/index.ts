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
// plan_mode_complete({ plan }). The plan is written to .pi/PLAN.md in the
// current working directory (not repo-root PLAN.md — that collides with
// projects' own PLAN.md files and would force a per-project gitignore entry)
// — you read/edit it, then /plan approve ends plan mode and starts
// implementation from that file. The file is the durable artifact: it
// survives compaction and is the implementation handoff, so plan mode never
// needs in-memory retention. A footer status and a widget show the state.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { blockedBashCommand } from "../../shared/bash-policy.mjs";
import { createDialogQueue } from "./dialog-queue.mjs";
import { fetchSmart } from "../web-fetch/fetch.mjs";
import { formatWebFetchResult, isKnownFormat } from "../web-fetch/format.mjs";
import { atomicWriteFile, resolvePlanFile } from "./plan-file.mjs";
import { CODE_SEARCH_TOOLS } from "../code-search/tools.mjs";
import { setReadOnlyMode } from "../../shared/mode-flags.mjs";

const QUESTION_TOOL = "plan_mode_question";
const COMPLETE_TOOL = "plan_mode_complete";
const FETCH_TOOL = "plan_fetch_url";
const SEARCH_TOOL = "web_search";
// lore_recall (from the lore extension) is read-only memory recall: it lets
// the planner surface prior decisions, preferences, and rejected approaches
// before grilling the user — exactly the "never ask what the store already
// knows" discipline Phase 1 needs. lore registers it, not this repo, so it is
// optional: if lore is not loaded the name matches nothing and the model is
// simply never offered the tool.
const RECALL_TOOL = "lore_recall";
// grep/find/ls are read-only built-ins, included like the reference plan-mode
// example's toolset. plan_fetch_url and web_search (from pi-web-fetch) are the
// sanctioned web paths — bash network tools stay blocked by the fail-closed
// policy. web_search resolves from the pi-web-fetch extension, which ships in
// the same repo. CODE_SEARCH_TOOLS (repo_map, code_search, file_outline,
// find_definition from pi-code-search) are read-only discovery tools — the
// core activity of plan mode.
const PLAN_TOOLS = ["read", "bash", "grep", "find", "ls", ...CODE_SEARCH_TOOLS, RECALL_TOOL, QUESTION_TOOL, COMPLETE_TOOL, FETCH_TOOL, SEARCH_TOOL];
const DEFAULT_TOOLS = ["read", "bash", "edit", "write"];
// .pi/ rather than repo root: a root PLAN.md collides with projects' own
// PLAN.md files and would force a per-project gitignore entry.
const PLAN_DIR = ".pi";
const PLAN_FILENAME = "PLAN.md";
const MAX_PLAN_CHARS = 50000;

const PLAN_MODE_PROMPT = `# Plan Mode (read-only)

You are in Plan Mode, a Codex-like collaboration mode for producing a decision-complete implementation plan. Chat your way to the plan before finalizing it. Grill the user for the full scope first: a plan is written only once every decision is settled and understood by both of you. A final plan must leave no implementation decisions unresolved.

## Mode rules

- Stay in Plan Mode until the user exits it. Treat requests to implement as requests to plan the implementation; do not edit files or carry out the plan.
- Do not use update_plan/TODO tooling; Plan Mode is conversational planning, not execution tracking.
- Do not perform mutating actions: no edit/write tools, no patching, no dependency installation, no commits, no migrations. Bash is restricted to a fail-closed allowlist of read-only commands (ls, cat, rg, find, git log/status/diff, npm ls, …) — test runners, script interpreters, installs, and network tools are blocked; do not attempt bash workarounds. For web research use plan_fetch_url (fetch a known URL) or web_search (keyless DuckDuckGo search) instead: they return readable content with sources.

## Phase 1 — Ground in the environment

- Recall memory first: call lore_recall with a query that captures the request's subject before exploring, to surface relevant prior decisions, preferences, rejected approaches, and recurring mistakes. Do not ask the user for anything lore already knows.
- Explore first and ask second. Use non-mutating exploration to read files, search, inspect configuration, and resolve discoverable facts. When the request needs current or external information (API docs, versions, references), research it online with plan_fetch_url or web_search before asking the user — never ask for something a fetch or search can look up.
- Do not ask questions that can be answered from repository or system truth. Ask only when multiple plausible choices remain, a needed identifier/context is missing, or the ambiguity is product intent.

## Phase 2 — Grill: scope & intent

Work the request as a design tree: every decision branches into the decisions that hang off it. The frontier is every decision whose prerequisites are already settled — the questions you can ask now without guessing at answers you haven't heard yet.

- Grill in rounds. Ask the whole frontier in one round: number each question, give 2-4 meaningful options where they exist, and give your recommended answer for each. Use plan_mode_question (with title and recommended) when UI is available; otherwise ask in plain text. Questions fired in one batch appear as sequential dialogs — one per question — and every answer comes back before you continue.
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
  // pi runs sibling tool calls concurrently, and the TUI dialog manager only
  // owns one dialog at a time. Serialize every interactive dialog (question
  // selects, the plan editor) so concurrent calls never open stacked dialogs
  // that hide each other and hang the tool batch.
  const enqueueDialog = createDialogQueue();

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
    setReadOnlyMode(true);
    updateStatus(ctx);
    notify(ctx, "Plan mode active — read-only. /plan exit to leave.");
  }

  function exitPlanMode(ctx: UiCtx, message?: string) {
    if (!state.enabled) return;
    state.enabled = false;
    pi.setActiveTools(state.previousTools ?? DEFAULT_TOOLS);
    state.previousTools = null;
    setReadOnlyMode(false);
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
    const base = path.join(dir, PLAN_DIR, PLAN_FILENAME);
    // Read from the file we currently own (base or a previously allocated
    // alternate) so a revision after landing on .2 compares against .2, not
    // the stale base — otherwise every later revision would mismatch and
    // allocate a fresh alternate forever. See plan-file.mjs's resolvePlanFile
    // doc comment for the full decision table.
    const owned = state.planPath;
    let existing: string | null = null;
    try {
      existing = await readFile(owned ?? base, "utf8");
    } catch {
      existing = null;
    }
    const chosen = resolvePlanFile({
      base,
      plan,
      existing,
      lastWritten,
      owned,
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
    // Queue with question dialogs so only one interactive dialog is open at a
    // time; read the file only when our turn comes so external edits made
    // while a question dialog was up are not clobbered.
    const editor = ctx.ui.editor;
    const planPath = state.planPath;
    const outcome = await enqueueDialog(async () => {
      let current: string;
      try {
        current = await readFile(planPath, "utf8");
      } catch (error) {
        notify(ctx, `Failed to read ${planPath}: ${(error as Error).message}`);
        return null;
      }
      const edited = await editor("Edit plan — Ctrl+G opens $EDITOR:", current);
      if (edited === undefined || edited === null) {
        notify(ctx, "Edit cancelled — plan unchanged.");
        return null;
      }
      return { edited, current };
    });
    if (outcome === null) return;
    const { edited, current } = outcome;
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
      const select = ctx.ui.select;
      try {
        const dialogTitle = [
          title ? `❓ ${title}` : "",
          question,
          recommended ? `➡️ Recommended: ${recommended}` : "",
        ]
          .filter((part) => part.length > 0)
          .join("\n\n");
        // Sibling tool calls run concurrently, so questions fired in one round
        // must share the dialog queue — an unqueued select would be hidden
        // behind the next question's dialog and hang the batch.
        const choice = await enqueueDialog(() => select(dialogTitle, options));
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

  pi.registerTool({
    name: FETCH_TOOL,
    label: "Fetch URL (read-only web access)",
    description:
      "Fetch an http(s) URL and return readable content for planning research — " +
      "the sanctioned network path (curl/wget are blocked in plan mode). " +
      "Returns clean markdown with title/URL metadata by default; GitHub URLs use the gh CLI when available. " +
      "Does not execute JavaScript. Use it instead of bash for anything network-related.",
    parameters: Type.Object({
      url: Type.String({ description: "The http(s) URL to fetch" }),
      format: Type.Optional(
        Type.String({
          description: "Output format: markdown (default), html, text, json, or raw.",
        }),
      ),
      maxChars: Type.Optional(
        Type.Integer({ minimum: 1000, description: "Content cap in characters (default 40000)." }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (!state.enabled) {
        return { content: [{ type: "text", text: "Not in plan mode — plan_fetch_url is inactive." }] };
      }
      const url = String(params?.url ?? "").trim();
      if (!url) {
        return { content: [{ type: "text", text: "Rejected: url is empty." }] };
      }
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return { content: [{ type: "text", text: `Rejected: "${url}" is not a valid URL.` }] };
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return {
          content: [{ type: "text", text: `Rejected: only http(s) URLs are allowed, got ${parsed.protocol}//.` }],
        };
      }
      const format = typeof params?.format === "string" ? params.format : "markdown";
      if (!isKnownFormat(format)) {
        return {
          content: [{
            type: "text",
            text: `Rejected: format must be one of markdown, html, text, json, raw. Got "${format}".`,
          }],
        };
      }
      const requestedMaxChars = Number(params?.maxChars);
      const maxChars = Number.isFinite(requestedMaxChars)
        ? Math.min(1_000_000, Math.max(1000, Math.trunc(requestedMaxChars)))
        : 40_000;

      // Same fetch engine as web_fetch (browser-like headers, redirects,
      // alternate-content fallback, gh for GitHub URLs), with plan mode's own
      // caps: 20s timeout, 40k default content cap, Esc-cancellable.
      onUpdate?.({ content: [{ type: "text", text: `Fetching ${url}…` }] });
      try {
        const outcome = await fetchSmart({ url, format, maxChars, timeoutMs: 20_000, signal });
        const text = formatWebFetchResult(outcome, { format, maxChars });
        if (!text.trim()) {
          return {
            content: [{
              type: "text",
              text: `Fetched ${outcome.finalUrl ?? url} — no readable content found.`,
            }],
          };
        }
        return { content: [{ type: "text", text }] };
      } catch (error) {
        const reason = signal?.aborted
          ? "cancelled by the user"
          : error instanceof Error
            ? error.message
            : String(error);
        return {
          content: [
            {
              type: "text",
              text: `Fetch failed: ${reason}. Try a different URL or skip the web research.`,
            },
          ],
        };
      }
    },
  });
}
