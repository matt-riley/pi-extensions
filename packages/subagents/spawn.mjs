// spawn.mjs — one in-process child via createAgentSession. Dispose on return.

import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { createChildPolicyExtension } from "./child-policy.mjs";
import { resolveChildTools, usesAllowlistedBash } from "./discover.mjs";
import {
  extractLastAssistantText,
  tokensFromUsage,
  turnAction,
} from "./result.mjs";
import { formatLastTool } from "./widget.mjs";

export const CHILD_ENV = "PI_SUBAGENT_CHILD";
const WRAP_MESSAGE = "Wrap up immediately — provide your final answer now.";

export function buildSystemPrompt(agent) {
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
  const prev = process.env[CHILD_ENV];
  process.env[CHILD_ENV] = "1";
  const restore = () => {
    if (prev === undefined) delete process.env[CHILD_ENV];
    else process.env[CHILD_ENV] = prev;
  };
  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return result.finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
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
  signal,
  onEvent,
  bind,
} = {}) {
  const startedAt = Date.now();
  const allowlistBash = usesAllowlistedBash(agent);
  const blockWriters = allowlistBash;
  let session;
  let unsub;
  let status = "completed";
  let wrapSent = false;
  let turns = 0;
  let toolUses = 0;
  let tokens = 0;
  let lastTool = "";

  const emit = (patch) => {
    onEvent?.(patch);
  };

  const abortChild = async (next = "stopped") => {
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

  try {
    const created = await withChildEnv(async () => {
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir: getAgentDir(),
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

    if (signal) {
      if (signal.aborted) {
        await abortChild("stopped");
        return finish();
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    unsub = session.subscribe((event) => {
      if (event?.type === "turn_end") {
        turns += 1;
        emit({ turns });
        const action = turnAction(turns, maxTurns);
        if (action === "wrap" && !wrapSent) {
          wrapSent = true;
          session.steer(WRAP_MESSAGE).catch(() => {});
        } else if (action === "abort" && status === "completed") {
          void abortChild("aborted");
        }
      } else if (event?.type === "tool_execution_start") {
        toolUses += 1;
        lastTool = formatLastTool(event);
        emit({ toolUses, lastTool });
      } else if (event?.type === "message_end" && event.message?.role === "assistant") {
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

  function finish(error) {
    if (status === "completed" && wrapSent && turns > maxTurns) status = "wrapped up";
    const messages = session?.messages ?? session?.agent?.state?.messages;
    const text = extractLastAssistantText(messages);
    return {
      status,
      text,
      turns,
      tokens,
      toolUses,
      lastTool,
      durationMs: Date.now() - startedAt,
      error,
    };
  }
}
