// spawn.mjs — one in-process child via createAgentSession. Dispose on return.

import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { acquireChildEnv, releaseChildEnv } from "./child-env.mjs";
import { createChildPolicyExtension, keepChildExtension } from "./child-policy.mjs";
import { resolveChildTools, usesAllowlistedBash } from "./discover.mjs";
import {
  accumulateUsage,
  buildPartialReport,
  emptyUsage,
  extractLastAssistantText,
  resolveFinalStatus,
  tokensFromUsage,
  turnAction,
} from "./result.mjs";
import { assessEvidence, collectEvidence, revisionSnapshot } from "./evidence.mjs";
import { formatLastTool } from "./widget.mjs";

const WRAP_MESSAGE = "Wrap up immediately — provide your final answer now.";
const TRACE_LIMIT = 15;

const warnMessage = (left) =>
  `${left} turn${left === 1 ? "" : "s"} left. Stop exploring, start converging, and write your final report.`;

// One JSON message per line. Best-effort: a failed write never fails the child.
function writeTranscript(runFile, messages) {
  if (!runFile || !Array.isArray(messages)) return false;
  try {
    mkdirSync(path.dirname(runFile), { recursive: true });
    writeFileSync(runFile, `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`);
    return true;
  } catch {
    return false;
  }
}

function buildSystemPrompt(agent) {
  const readonly = usesAllowlistedBash(agent);
  const name = agent?.name || "agent";
  const body = agent?.systemPrompt || "";
  const preamble = [
    `You are running as a ${readonly ? "read-only" : "write-capable"} subagent named ${name}.`,
    "You cannot spawn other agents. When done, write your complete final answer.",
  ].join(" ");
  return body ? `${body}\n\n${preamble}` : preamble;
}

function withChildEnv(fn) {
  acquireChildEnv();
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return result.finally(releaseChildEnv);
    }
    releaseChildEnv();
    return result;
  } catch (error) {
    releaseChildEnv();
    throw error;
  }
}

export async function runChild({
  cwd,
  agent,
  task,
  model,
  thinkingLevel,
  maxTurns,
  timeoutMs,
  signal,
  onEvent,
  bind,
  runFile,
  acceptance = [],
} = {}) {
  const startedAt = Date.now();
  const beforeRevision = await revisionSnapshot(cwd);
  const evidence = [];
  const allowlistBash = usesAllowlistedBash(agent);
  const blockWriters = allowlistBash;
  let session;
  let unsub;
  let timer;
  let status = "completed";
  let wrapSent = false;
  let warnSent = false;
  const toolTrace = [];
  let turns = 0;
  let toolUses = 0;
  let tokens = 0;
  let lastTool = "";
  const usage = emptyUsage();

  const emit = (patch) => {
    onEvent?.(patch);
  };

  // Only transition out of "completed" once — the first terminal signal wins.
  const abortChild = async (next = "stopped") => {
    if (status !== "completed") return;
    status = next;
    try {
      await session?.abort();
    } catch {
      // already idle or disposed
    }
  };

  const onAbort = () => {
    void abortChild("stopped");
  };

  const timeout = Number(timeoutMs);
  if (Number.isFinite(timeout) && timeout > 0) {
    timer = setTimeout(() => void abortChild("timed out"), timeout);
  }

  try {
    const created = await withChildEnv(async () => {
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir: getAgentDir(),
        extensionsOverride: (base) => ({
          ...base,
          extensions: base.extensions.filter(keepChildExtension),
        }),
        systemPromptOverride: () => buildSystemPrompt(agent),
        appendSystemPromptOverride: () => [],
        extensionFactories: [createChildPolicyExtension({ allowlistBash, blockWriters })],
      });
      await loader.reload();

      const { tools: childTools, excludeTools } = resolveChildTools(agent);
      const opts = {
        cwd,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
        model,
        thinkingLevel,
      };
      if (childTools) opts.tools = childTools;
      opts.excludeTools = excludeTools;
      return createAgentSession(opts);
    });
    session = created.session;
    bind?.({
      abort: () => abortChild("stopped"),
      session,
    });

    // A timeout or abort may have landed while the session was being created.
    if (status !== "completed") return finish();

    if (signal) {
      if (signal.aborted) {
        await abortChild("stopped");
        return finish();
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    unsub = session.subscribe((event) => {
      collectEvidence(evidence, event);
      if (event?.type === "turn_end") {
        turns += 1;
        emit({ turns });
        const action = turnAction(turns, maxTurns);
        if (action === "warn" && !warnSent) {
          warnSent = true;
          session.steer(warnMessage(maxTurns - turns)).catch(() => {});
        } else if (action === "wrap" && !wrapSent) {
          wrapSent = true;
          session.steer(WRAP_MESSAGE).catch(() => {});
        } else if (action === "abort" && status === "completed") {
          void abortChild("aborted");
        }
      } else if (event?.type === "tool_execution_start") {
        toolUses += 1;
        lastTool = formatLastTool(event);
        toolTrace.push(lastTool);
        if (toolTrace.length > TRACE_LIMIT) toolTrace.shift();
        emit({ toolUses, lastTool });
      } else if (event?.type === "message_end" && event.message?.role === "assistant") {
        accumulateUsage(usage, event.message.usage);
        tokens += tokensFromUsage(event.message.usage);
        emit({ tokens });
      }
    });

    try {
      await session.prompt(task);
    } catch (error) {
      if (status === "completed") {
        status = "error";
        return finish(error instanceof Error ? error.message : String(error));
      }
    }

    return finish();
  } catch (error) {
    if (status === "completed") status = "error";
    return finish(error instanceof Error ? error.message : String(error));
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
    try {
      unsub?.();
    } catch {
      // ignore
    }
    try {
      session?.dispose();
    } catch {
      // ignore
    }
  }

  async function finish(error) {
    const messages = session?.messages ?? session?.agent?.state?.messages;
    const finalStatus = resolveFinalStatus({ status, wrapSent, turns, maxTurns });
    const lastText = extractLastAssistantText(messages);
    const clean = finalStatus === "completed" || finalStatus === "wrapped up";
    const transcriptSaved = writeTranscript(runFile, messages);
    const assessment = assessEvidence({
      criteria: acceptance,
      evidence,
      before: beforeRevision,
      after: await revisionSnapshot(cwd),
      status: finalStatus,
      transcriptSaved,
    });
    return {
      status: finalStatus,
      assessment,
      text:
        clean && lastText.trim() ? lastText : buildPartialReport(messages, toolTrace) || lastText,
      turns,
      tokens,
      toolUses,
      lastTool,
      durationMs: Date.now() - startedAt,
      usage,
      error,
    };
  }
}
