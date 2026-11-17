// pi-subagents — in-process parallel children. Off by default; /subagents on.
// When off, the tool is inactive and zero orchestrator text reaches the model.

import { type ExtensionAPI, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { aggregate, formatAggregate } from "./aggregate.mjs";
import { combineSignals } from "./combine-signals.mjs";
import { CROSS_FAMILY, resolveCrossFamily, resolvePanel } from "./cross-family.mjs";
import { physicalParentKeyForCrossFamily } from "../router/parent-physical.mjs";
import { changedFiles, describeChanges, snapshotChanges } from "./diff.mjs";
import { discoverAgents, findAgent, usesAllowlistedBash } from "./discover.mjs";
import { checkDiffScope, preflightTask, triageResult } from "./judge.mjs";
import { isReadOnlyMode } from "../../shared/mode-flags.mjs";
import { shortSha } from "../../shared/revision.mjs";
import { VERDICT_ENTRY, verdictEntry } from "../../shared/verdict.mjs";
import { bindSystemOne } from "../../shared/systemone-session.mjs";
import { LOCAL_READ, OPEN_DESTRUCTIVE } from "../../shared/tool-annotations.mjs";
import { orchestratorPrompt, TASK_DESCRIPTION, TOOL_DESCRIPTION } from "./orchestrate.mjs";
import { reconcileActiveTools, resolveChildModel } from "./policy.mjs";
import { createPool } from "./pool.mjs";
import { fallbackDescription, formatResult, resolveMaxTurns, resolveTimeoutMs } from "./result.mjs";
import { CHILD_ENV } from "./child-env.mjs";
import { runChild } from "./spawn.mjs";
import { formatWidgetLines } from "./widget.mjs";
import { createWorktrees, worktreeLine } from "./worktree.mjs";

const WIDGET_ID = "subagents";
const TOOL_NAME = "subagent";
const BUILTIN_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "agents");

// Shared across extension instances in this process: survives session switches,
// resets to off when pi restarts.
let enabled = false;
let runsPruned = false;

const KEEP_RUNS = 200;
// Finished children swarm_report can read by id; the oldest are forgotten first.
const KEEP_RESULTS = 50;

interface Worktree {
  root: string;
  path: string;
  branch: string;
  base: string;
  cwd: string;
  baseline: string | null;
}

// Transcripts are the only way to see why a child went wrong; keep the newest.
function pruneRuns(dir: string) {
  try {
    const files = readdirSync(dir).sort();
    for (const file of files.slice(0, Math.max(0, files.length - KEEP_RUNS))) {
      unlinkSync(path.join(dir, file));
    }
  } catch {
    // no runs yet
  }
}

interface UiCtx {
  hasUI?: boolean;
  cwd?: string;
  isProjectTrusted?: () => boolean;
  model?: unknown;
  thinkingLevel?: string;
  modelRegistry?: {
    getModel?: (provider: string, id: string) => unknown;
    getAvailable?: () => unknown;
  };
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

export default function piSubagentsExtension(pi: ExtensionAPI) {
  if (process.env[CHILD_ENV] === "1") return;
  bindSystemOne(pi, "subagents");

  let widgetCtx: UiCtx | undefined;
  // Built on first use: the agent dir is the host's to report, not known at load.
  let worktreeStore: ReturnType<typeof createWorktrees> | undefined;
  const worktrees = () => (worktreeStore ??= createWorktrees({ agentDir: getAgentDir() }));
  // Worktrees made in this session: removed at shutdown only when the child left nothing.
  const made: Worktree[] = [];
  const finished = new Map<string, { agent: string; status: string; text: string }>();

  function remember(id: string, record: { agent: string; status: string; text: string }) {
    finished.set(id, record);
    for (const key of finished.keys()) {
      if (finished.size <= KEEP_RESULTS) break;
      finished.delete(key);
    }
  }

  const pool = createPool({
    onChange() {
      const lines = formatWidgetLines(pool.list(), pool.queuedCount());
      widgetCtx?.ui?.setWidget?.(WIDGET_ID, lines);
      updateStatus(widgetCtx);
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
      const next = reconcileActiveTools(active, enabled, TOOL_NAME);
      if (next !== active) pi.setActiveTools(next);
    } catch {
      // tool registry not ready yet; session_start re-asserts
    }
  }

  function updateStatus(ctx: UiCtx | undefined) {
    if (!ctx?.hasUI || !ctx.ui) return;
    if (!enabled || !isToolActive()) {
      ctx.ui.setStatus?.(WIDGET_ID, undefined);
      return;
    }
    const running = pool.runningCount();
    const queued = pool.queuedCount();
    const text =
      running > 0 || queued > 0
        ? `subagents: ${running} running${queued > 0 ? ` · ${queued} queued` : ""}`
        : "subagents on";
    ctx.ui.setStatus?.(WIDGET_ID, text);
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
    // Pi 1.2+: a prompt section, not a full `systemPrompt` replacement.
    event.systemPromptOptions.sections.orchestrator = orchestratorPrompt(loadAgents(ctx));
  });

  pi.on("session_shutdown", async () => {
    pool.abortAll();
    for (const wt of made.splice(0)) {
      try {
        await worktrees().removeIfEmpty(wt);
      } catch {
        // kept; /subagents lists it
      }
    }
    widgetCtx?.ui?.setWidget?.(WIDGET_ID, undefined);
    widgetCtx?.ui?.setStatus?.(WIDGET_ID, undefined);
    widgetCtx = undefined;
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Subagent",
    annotations: OPEN_DESTRUCTIVE,
    description: TOOL_DESCRIPTION,
    promptSnippet:
      "Spawn a specialist subagent (scout, reviewer, verifier, oracle, worker, researcher, or a custom type)",
    parameters: Type.Object({
      agent: Type.String({
        description:
          "Agent type (scout, reviewer, verifier, oracle, worker, researcher, or a custom name)",
      }),
      task: Type.String({ description: TASK_DESCRIPTION }),
      acceptance: Type.Optional(
        Type.Array(
          Type.Object({
            criterion: Type.String({ description: "Acceptance criterion supplied by the parent" }),
            command: Type.String({
              description:
                "Exact bash command whose successful execution establishes this criterion",
            }),
          }),
          {
            maxItems: 8,
            description:
              "Optional explicit acceptance contracts. Command success verifies only these contracts on an unchanged revision; it does not validate arbitrary prose.",
          },
        ),
      ),
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
      model: Type.Optional(
        Type.String({
          description:
            'Optional "provider/id" for this child, or "cross-family". Overrides the agent type\'s default model.',
        }),
      ),
      timeout_ms: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 7200000,
          description:
            "Wall-clock cap for this child (ms, up to 2h). May only lower the resolved cap.",
        }),
      ),
      isolation: Type.Optional(
        Type.Literal("worktree", {
          description:
            "Run this child in its own git worktree at the current HEAD plus uncommitted changes. " +
            "Use for parallel writers and for adversaries that write repro scripts. " +
            "The result names the worktree and its diff; nothing is merged for you.",
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

      const cwd = ctx?.cwd || process.cwd();
      // Both the session-level abort (ctx.signal) and the per-tool-call abort
      // (signal) must be able to cancel the child — a plain `??` only wires up
      // one and silently drops the other's cancellation.
      const abortSignal = combineSignals([ctx?.signal, signal]);
      const writeCapable = !usesAllowlistedBash(agent);

      const preflight = await preflightTask({
        agent: agent.name,
        task,
        writeCapable,
        cwd,
        signal: abortSignal,
      });
      if (preflight.reject) {
        // Not isError: pi would blindly auto-retry the same call.
        return { content: [{ type: "text", text: preflight.reject }] };
      }
      const childTask = preflight.hints.length
        ? `${task}\n\nHarness notes:\n${preflight.hints.map((hint) => `- ${hint}`).join("\n")}`
        : task;

      const description =
        typeof params?.description === "string" && params.description.trim()
          ? params.description.trim()
          : fallbackDescription(task);
      const maxTurns = resolveMaxTurns(agent.maxTurns, params?.max_turns);
      const timeoutMs = resolveTimeoutMs(agent.timeoutMs, params?.timeout_ms);
      const isolated = params?.isolation === "worktree";
      const { entry, ready } = pool.acquire(agent.name, {
        description,
        task,
        maxTurns,
        write: writeCapable,
        isolated,
      });

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

      let wt: Worktree | undefined;
      if (isolated) {
        try {
          wt = (await worktrees().create(cwd, entry.id)) as Worktree;
          made.push(wt);
        } catch (error) {
          pool.release(entry.id);
          const reason = error instanceof Error ? error.message : String(error);
          // Not isError: the same call would fail the same way.
          return {
            content: [
              { type: "text", text: `Could not create a worktree, so nothing ran: ${reason}` },
            ],
          };
        }
      }
      const childCwd = wt?.cwd ?? cwd;

      pi.events.emit("subagents:started", { id: entry.id, type: agent.name, description });
      const modelSpec =
        typeof params?.model === "string" && params.model.trim()
          ? params.model.trim()
          : agent.model;
      const routerFile = path.join(getAgentDir(), "router.json");
      const { model, note: modelNote } =
        modelSpec === CROSS_FAMILY
          ? await resolveCrossFamily(ctx?.modelRegistry, ctx?.model, routerFile, {
              physicalParentKey: physicalParentKeyForCrossFamily(ctx?.model, ctx, routerFile),
            })
          : resolveChildModel(ctx?.modelRegistry, ctx?.model, modelSpec);
      const runsDir = path.join(getAgentDir(), "subagent-runs");
      if (!runsPruned) {
        runsPruned = true;
        pruneRuns(runsDir);
      }
      const runFile = path.join(runsDir, `${Date.now()}-${entry.id}.jsonl`);
      const before = writeCapable && !wt ? await snapshotChanges(cwd) : undefined;

      try {
        const result = await runChild({
          cwd: childCwd,
          agent,
          task:
            childTask +
            (params.acceptance?.length
              ? `\nAcceptance commands supplied by the parent:\n${JSON.stringify(params.acceptance)}`
              : ""),
          acceptance: params.acceptance,
          model,
          thinkingLevel: agent.thinking ?? ctx?.thinkingLevel,
          maxTurns,
          timeoutMs,
          signal: abortSignal,
          runFile,
          onEvent: (patch) => {
            pool.update(entry.id, patch);
            const current = pool.get(entry.id);
            if (!current) return;
            const turns =
              current.maxTurns != null
                ? `↻${current.turns}≤${current.maxTurns}`
                : `↻${current.turns}`;
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
        } else if (["error", "aborted", "timed out"].includes(result.status)) {
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

        const clean = result.status === "completed" || result.status === "wrapped up";
        let changes: { stat: string; diff: string };
        let placeLine = "";
        if (wt) {
          const left = await worktrees()
            .describe(wt)
            .catch(() => ({
              commits: 0,
              changed: true,
              known: false,
              stat: "",
              diff: "",
            }));
          changes = { stat: left.stat, diff: left.diff };
          placeLine = worktreeLine(wt, left);
        } else {
          const changed = before ? changedFiles(before, await snapshotChanges(cwd)) : [];
          changes = await describeChanges(cwd, changed);
        }
        remember(entry.id, { agent: agent.name, status: result.status, text: result.text ?? "" });
        // A verdict covers a patch: watch_pr compares this patch id with the PR's.
        let verdictNote = "";
        if (agent.name === "verifier" && clean) {
          const recorded = await verdictEntry({
            text: result.text,
            cwd: childCwd,
            head: result.assessment?.revision?.head,
            id: entry.id,
          });
          pi.appendEntry(VERDICT_ENTRY, recorded);
          verdictNote = `verdict recorded: ${recorded.verdict}, patch ${shortSha(recorded.patchId) || "unknown"} against ${recorded.base ?? "no default branch"}`;
        }
        const [triage, scopeWarning] = await Promise.all([
          clean
            ? triageResult({ agent: agent.name, task, text: result.text, signal: abortSignal })
            : undefined,
          writeCapable
            ? checkDiffScope({ task, diff: changes.diff, signal: abortSignal })
            : undefined,
        ]);
        const note = [
          `id: ${entry.id}`,
          modelNote,
          placeLine,
          triage ? `triage: ${triage}` : "",
          changes.stat ? `changes:\n${changes.stat}` : "",
          scopeWarning,
          verdictNote,
        ]
          .filter(Boolean)
          .join("\n");

        const text = formatResult({
          agent: agent.name,
          description,
          status: result.status,
          turns: result.turns,
          tokens: result.tokens,
          durationMs: result.durationMs,
          text: result.error && !result.text ? result.error : result.text,
          note,
          runFile,
          assessment: result.assessment,
        });
        return {
          content: [{ type: "text", text }],
          isError: false,
          usage: result.usage,
          details: {
            executionStatus: result.status,
            assessment: result.assessment,
            transcript: runFile,
          },
        };
      } finally {
        pool.release(entry.id);
      }
    },
  });

  // Worktrees a child left work in. They outlive the session; git lists them.
  async function keptWorktrees(cwd: string) {
    try {
      const kept = await worktrees().listKept(cwd);
      if (!kept.length) return "";
      const list = kept.map((item) => `${item.path} (${item.branch})`).join(", ");
      return `Subagent worktrees kept because they hold work: ${list}. Remove one with git worktree remove <path> once grafted.`;
    } catch {
      return "";
    }
  }

  pi.registerTool({
    name: "review_panel",
    label: "review_panel",
    exposure: "deferred",
    annotations: LOCAL_READ,
    description:
      "Seats for a multi-model panel: up to three authenticated models, one per vendor, from roles.panel in " +
      "~/.pi/agent/router.json, else its tiers; plus a judge outside the parent's vendor from roles.judge. " +
      "Returns {seats, judge?, notes}. A panel with fewer than two vendors says so: it repeats one set of " +
      "blind spots. Pass each seat as subagent's model. Reads config only.",
    promptSnippet:
      "review_panel(): model seats (one per vendor) and a judge for interrogate or arena",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const routerFile = path.join(getAgentDir(), "router.json");
      const panel = await resolvePanel(ctx?.modelRegistry, ctx?.model, routerFile, {
        physicalParentKey: physicalParentKeyForCrossFamily(ctx?.model, ctx, routerFile),
      });
      return { content: [{ type: "text", text: JSON.stringify(panel) }], details: panel };
    },
  });

  pi.registerTool({
    name: "swarm_report",
    label: "swarm_report",
    exposure: "deferred",
    annotations: LOCAL_READ,
    description:
      "Aggregate finished subagent results by the id on each result. A slice whose child did not finish, " +
      "whose text does not open with PASS, ISSUES or BLOCKED, or (with expect_sha) that does not name the " +
      "commit it checked is a GAP, and a gap is never a pass. Overall is PASS only when every required " +
      "slice passed; with none marked required, all are. Reads results from this session only.",
    promptSnippet:
      "swarm_report(slices, expect_sha?): PASS / ISSUES / INCOMPLETE over finished subagent ids; gaps are not passes",
    parameters: Type.Object({
      slices: Type.Array(
        Type.Object({
          id: Type.String({ description: "The id: line on a subagent result" }),
          slice: Type.Optional(
            Type.String({ description: "Name for the row; defaults to the id" }),
          ),
          required: Type.Optional(Type.Boolean()),
        }),
        { maxItems: 32 },
      ),
      expect_sha: Type.Optional(
        Type.String({ description: "Commit every worker was told to check and record" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const slices: { id?: unknown; slice?: unknown; required?: unknown }[] = Array.isArray(
        params?.slices,
      )
        ? params.slices
        : [];
      const results = slices.map((item) => {
        const id = String(item?.id ?? "");
        const found = finished.get(id);
        const required = item?.required;
        return {
          slice: typeof item?.slice === "string" && item.slice ? item.slice : id,
          required: typeof required === "boolean" ? required : undefined,
          status: found?.status ?? "missing (no finished result with this id)",
          text: found?.text,
        };
      });
      const expectSha =
        typeof params?.expect_sha === "string" && params.expect_sha.trim()
          ? params.expect_sha.trim()
          : undefined;
      const report = aggregate(results, { expectSha });
      return { content: [{ type: "text", text: formatAggregate(report) }], details: report };
    },
  });

  pi.registerCommand("subagents", {
    description: "Toggle subagents on/off, or steer/stop a running child",
    handler: async (args, ctx) => {
      const arg = String(args ?? "")
        .trim()
        .toLowerCase();
      if (arg === "on" || arg === "off") {
        if (arg === "on") {
          if (isReadOnlyMode()) {
            notify(ctx, "Can't enable subagents while plan mode is active — /plan exit first.");
            return;
          }
          const active = pi.getActiveTools();
          const readOnlyToolset = !active.includes("edit") && !active.includes("write");
          if (readOnlyToolset) {
            notify(
              ctx,
              "Can't enable subagents in a read-only toolset (plan mode?) — exit it first.",
            );
            return;
          }
        }
        enabled = arg === "on";
        applySubagentState();
        updateStatus(ctx);
        if (enabled) {
          const roster =
            loadAgents(ctx)
              .map((item) => item.name)
              .join(", ") || "none";
          notify(ctx, `Subagents on — available: ${roster}. /subagents off to disable.`);
        } else {
          notify(ctx, "Subagents off — tool and orchestrator brief removed.");
        }
        return;
      }

      const kept = await keptWorktrees(ctx?.cwd || process.cwd());
      if (kept) notify(ctx, kept);
      const fleet = pool.list();
      if (fleet.length === 0) {
        if (enabled && !isToolActive()) {
          if (isReadOnlyMode()) {
            notify(ctx, "Subagents enabled but unavailable while plan mode is active");
          } else {
            notify(ctx, "Subagents enabled but unavailable in this read-only toolset");
          }
        } else {
          notify(
            ctx,
            enabled ? "No running subagents" : "Subagents are off — /subagents on to enable",
          );
        }
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
      let actions: string[] = [];
      if (entry.status === "running") actions = ["Steer", "Stop"];
      else if (entry.status === "queued") actions = ["Stop"];
      if (actions.length === 0) {
        notify(ctx, `${id} is no longer steerable or stoppable (status: ${entry.status})`);
        return;
      }
      const action = await ctx.ui.select(`${id}`, actions);
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
