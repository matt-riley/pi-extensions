// pi-subagents — in-process parallel children. Off by default; /subagents on.
// When off, the tool is inactive and zero orchestrator text reaches the model.

import {
  type ExtensionAPI,
  getAgentDir,
  parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverAgents, findAgent } from "./discover.mjs";
import { withOrchestratorPrompt } from "./orchestrate.mjs";
import { createPool } from "./pool.mjs";
import {
  fallbackDescription,
  formatResult,
  resolveMaxTurns,
} from "./result.mjs";
import { CHILD_ENV, runChild } from "./spawn.mjs";
import { formatWidgetLines } from "./widget.mjs";

const WIDGET_ID = "subagents";
const TOOL_NAME = "subagent";
const BUILTIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "agents");

// Shared across extension instances in this process: survives session switches,
// resets to off when pi restarts.
let enabled = false;

const TOOL_DESCRIPTION = [
  "Spawn a specialist child with a complete, self-contained task.",
  "Fire multiple subagent calls in one turn to run them in parallel, then synthesize.",
  "Built-in types: scout (recon), reviewer (code review), oracle (second opinion), worker (implements a fully-specified change; write-capable), researcher (web/docs research).",
  "Custom types live in .pi/agents/*.md or ~/.pi/agent/agents/*.md. Children cannot spawn children.",
].join(" ");

interface UiCtx {
  hasUI?: boolean;
  cwd?: string;
  isProjectTrusted?: () => boolean;
  model?: unknown;
  thinkingLevel?: string;
  modelRegistry?: { getModel?: (provider: string, id: string) => unknown };
  signal?: AbortSignal;
  ui?: {
    notify?: (title: string, level?: string) => void;
    setStatus?: (id: string, text: string | undefined) => void;
    setWidget?: (id: string, lines: string[] | undefined) => void;
    select?: (title: string, options: string[]) => Promise<string | undefined>;
    input?: (title: string, value?: string) => Promise<string | undefined>;
  };
}

function notify(ctx: UiCtx | undefined, message: string, level = "info") {
  if (ctx?.hasUI) ctx.ui?.notify?.(message, level);
}

function resolveChildModel(ctx: UiCtx | undefined, spec?: string) {
  if (!spec) return { model: ctx?.model, note: undefined as string | undefined };
  const slash = spec.indexOf("/");
  if (slash <= 0) {
    return { model: ctx?.model, note: `unresolved model "${spec}"; inherited parent` };
  }
  const provider = spec.slice(0, slash);
  const id = spec.slice(slash + 1);
  try {
    const found = ctx?.modelRegistry?.getModel?.(provider, id);
    if (found) return { model: found, note: undefined };
  } catch {
    // inherit
  }
  return { model: ctx?.model, note: `unresolved model "${spec}"; inherited parent` };
}

export default function piSubagentsExtension(pi: ExtensionAPI) {
  if (process.env[CHILD_ENV] === "1") return;

  let widgetCtx: UiCtx | undefined;

  const pool = createPool({
    onChange() {
      const lines = formatWidgetLines(pool.list(), pool.queuedCount());
      widgetCtx?.ui?.setWidget?.(WIDGET_ID, lines);
    },
  });

  function loadAgents(ctx: UiCtx | undefined) {
    const warnings: string[] = [];
    const cwd = ctx?.cwd || process.cwd();
    const trusted = typeof ctx?.isProjectTrusted === "function" ? ctx.isProjectTrusted() : false;
    const { agents } = discoverAgents({
      builtinDir: BUILTIN_DIR,
      userDir: path.join(getAgentDir(), "agents"),
      projectDir: path.join(cwd, ".pi", "agents"),
      projectTrusted: trusted,
      parseFrontmatter,
      warn: (message) => warnings.push(message),
    });
    for (const message of warnings) notify(ctx, message);
    return agents;
  }

  function isToolActive() {
    try {
      return pi.getActiveTools().includes(TOOL_NAME);
    } catch {
      return false;
    }
  }

  // Keep the active tool set in sync with the enabled flag. Called at session
  // start (a fresh session must not inherit the tool) and on every toggle.
  function applySubagentState() {
    try {
      const active = pi.getActiveTools();
      const has = active.includes(TOOL_NAME);
      if (enabled && !has) {
        pi.setActiveTools([...new Set([...active, TOOL_NAME])]);
      } else if (!enabled && has) {
        pi.setActiveTools(active.filter((tool) => tool !== TOOL_NAME));
      }
    } catch {
      // tool registry not ready yet; session_start re-asserts
    }
  }

  function updateStatus(ctx: UiCtx | undefined) {
    if (!ctx?.hasUI || !ctx.ui) return;
    ctx.ui.setStatus?.(WIDGET_ID, enabled ? "subagents on" : undefined);
  }

  pi.on("session_start", (_event, ctx) => {
    widgetCtx = ctx;
    applySubagentState();
    updateStatus(ctx);
  });

  // The orchestrator brief (roster + spawn rules) is opt-in: only appended
  // while the user enabled subagents and the tool is actually active.
  pi.on("before_agent_start", async (event, ctx) => {
    if (!enabled || !isToolActive()) return;
    const agents = loadAgents(ctx);
    return { systemPrompt: withOrchestratorPrompt(event.systemPrompt, agents) };
  });

  pi.on("session_shutdown", async () => {
    pool.abortAll();
    widgetCtx?.ui?.setWidget?.(WIDGET_ID, undefined);
    widgetCtx?.ui?.setStatus?.(WIDGET_ID, undefined);
    widgetCtx = undefined;
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Subagent",
    description: TOOL_DESCRIPTION,
    promptSnippet:
      "Spawn a specialist subagent (scout, reviewer, oracle, worker, researcher, or a custom type)",
    parameters: Type.Object({
      agent: Type.String({ description: "Agent type (scout, reviewer, oracle, worker, researcher, or a custom name)" }),
      task: Type.String({ description: "The full task for the child. It cannot see this conversation." }),
      description: Type.Optional(
        Type.String({ description: "Short 3-5 word summary shown in the widget" }),
      ),
      max_turns: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 30,
          description: "Turn cap for this child (1-30). May only lower the resolved cap.",
        }),
      ),
    }),
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const agentName = String(params?.agent ?? "").trim();
      const task = String(params?.task ?? "").trim();
      if (!agentName) {
        return { content: [{ type: "text", text: "Rejected: agent is empty." }], isError: true };
      }
      if (!task) {
        return { content: [{ type: "text", text: "Rejected: task is empty." }], isError: true };
      }

      const agents = loadAgents(ctx);
      const agent = findAgent(agents, agentName);
      if (!agent) {
        const known = agents.map((item) => item.name).join(", ") || "none";
        return {
          content: [
            {
              type: "text",
              text: `Unknown or disabled agent type "${agentName}". Known: ${known}.`,
            },
          ],
          isError: true,
        };
      }

      const description =
        typeof params?.description === "string" && params.description.trim()
          ? params.description.trim()
          : fallbackDescription(task);
      const maxTurns = resolveMaxTurns(agent.maxTurns, params?.max_turns);
      const { entry, ready } = pool.acquire(agent.name, { description, task, maxTurns });

      const started = await ready;
      if (started.stoppedBeforeStart) {
        pi.events.emit("subagents:stopped", { id: entry.id, type: agent.name });
        return {
          content: [
            {
              type: "text",
              text: formatResult({
                agent: agent.name,
                description,
                status: "stopped",
                turns: 0,
                tokens: 0,
                durationMs: 0,
                text: "",
              }),
            },
          ],
        };
      }

      pi.events.emit("subagents:started", { id: entry.id, type: agent.name, description });
      const { model, note } = resolveChildModel(ctx, agent.model);

      try {
        const result = await runChild({
          cwd: ctx?.cwd || process.cwd(),
          agent,
          task,
          model,
          thinkingLevel: agent.thinking ?? ctx?.thinkingLevel,
          maxTurns,
          signal: ctx?.signal ?? signal,
          onEvent: (patch) => {
            pool.update(entry.id, patch);
            const current = pool.get(entry.id);
            if (!current) return;
            const turns =
              current.maxTurns != null ? `↻${current.turns}≤${current.maxTurns}` : `↻${current.turns}`;
            const line = current.lastTool
              ? `${current.type}  ${current.description} · ${turns} · ${current.lastTool}`
              : `${current.type}  ${current.description} · ${turns}`;
            onUpdate?.({ content: [{ type: "text", text: line }] });
          },
          bind: (handle) => {
            pool.update(entry.id, {
              abort: () => handle.abort(),
              steer: (message: string) => handle.session.steer(message),
            });
          },
        });

        if (result.status === "stopped") {
          pi.events.emit("subagents:stopped", { id: entry.id, type: agent.name });
        } else if (result.status === "error" || result.status === "aborted") {
          pi.events.emit("subagents:failed", {
            id: entry.id,
            type: agent.name,
            status: result.status,
            error: result.error,
          });
        } else {
          pi.events.emit("subagents:completed", {
            id: entry.id,
            type: agent.name,
            durationMs: result.durationMs,
            tokens: result.tokens,
            toolUses: result.toolUses,
          });
        }

        const text = formatResult({
          agent: agent.name,
          description,
          status: result.status,
          turns: result.turns,
          tokens: result.tokens,
          durationMs: result.durationMs,
          text: result.error && !result.text ? result.error : result.text,
          note,
        });
        return {
          content: [{ type: "text", text }],
          isError: result.status === "error",
        };
      } finally {
        pool.release(entry.id);
      }
    },
  });

  pi.registerCommand("subagents", {
    description: "Toggle subagents on/off, or steer/stop a running child",
    handler: async (args, ctx) => {
      const arg = String(args ?? "").trim().toLowerCase();
      if (arg === "on" || arg === "off") {
        enabled = arg === "on";
        applySubagentState();
        updateStatus(ctx);
        if (enabled) {
          const roster = loadAgents(ctx).map((item) => item.name).join(", ") || "none";
          notify(ctx, `Subagents on — available: ${roster}. /subagents off to disable.`);
        } else {
          notify(ctx, "Subagents off — tool and orchestrator brief removed.");
        }
        return;
      }

      const fleet = pool.list();
      if (fleet.length === 0) {
        notify(ctx, enabled ? "No running subagents" : "Subagents are off — /subagents on to enable");
        return;
      }
      if (!ctx.hasUI || !ctx.ui?.select) {
        notify(ctx, `Subagents: ${fleet.map((item) => item.id).join(", ")}`);
        return;
      }
      const labels = fleet.map(
        (item) => `${item.id}  ${item.type}  ${item.status}  ${item.description}`,
      );
      const choice = await ctx.ui.select("Subagents", labels);
      if (!choice) return;
      const id = String(choice).split(/\s+/)[0];
      const entry = pool.get(id);
      if (!entry) {
        notify(ctx, `No subagent ${id}`);
        return;
      }
      const action = await ctx.ui.select(`${id}`, ["Steer", "Stop"]);
      if (action === "Stop") {
        pool.stop(id);
        pi.events.emit("subagents:stopped", { id, type: entry.type });
        notify(ctx, `Stopped ${id}`);
        return;
      }
      if (action !== "Steer") return;
      const steer = (entry as { steer?: (text: string) => Promise<void> }).steer;
      if (entry.status !== "running" || typeof steer !== "function") {
        notify(ctx, `${id} is not running`);
        return;
      }
      if (!ctx.ui.input) {
        notify(ctx, "No input dialog available");
        return;
      }
      const message = await ctx.ui.input(`Steer ${id}`);
      if (!message || !String(message).trim()) return;
      await steer(String(message).trim());
      pi.events.emit("subagents:steered", { id, message: String(message).trim() });
      notify(ctx, `Steered ${id}`);
    },
  });
}
