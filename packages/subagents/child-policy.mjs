// child-policy.mjs — inline child-session extension: bash allowlist / block writers.

import { blockedBashCommand } from "../../shared/bash-policy.mjs";

export function evaluateChildToolCall(event, { allowlistBash = false, blockWriters = false } = {}) {
  const name = event?.toolName;
  if (name === "subagent") {
    return { block: true, reason: "Subagents cannot spawn subagents." };
  }
  if (blockWriters && (name === "edit" || name === "write")) {
    return { block: true, reason: `Read-only subagent blocks ${name}.` };
  }
  if (allowlistBash && name === "bash") {
    const command = typeof event.input?.command === "string" ? event.input.command : "";
    const blocked = blockedBashCommand(command);
    if (blocked) {
      return { block: true, reason: `Read-only subagent blocks bash command: ${blocked}` };
    }
  }
  return undefined;
}

export function createChildPolicyExtension({ allowlistBash = false, blockWriters = false } = {}) {
  return {
    name: "subagent-child-policy",
    factory(pi) {
      pi.on("tool_call", async (event) =>
        evaluateChildToolCall(event, { allowlistBash, blockWriters }),
      );
    },
  };
}

// Extensions a child should not load: they inject persona, memory or
// prompt-rewriting meant for the interactive session, which costs tokens and
// distracts a focused worker. Tool extensions (code-search, web-fetch, typesafe,
// guardrail) stay. The router is loaded on purpose: a child inherits the
// `router/auto` model, so the extension that registers it must be there. Its
// route() sees PI_SUBAGENT_CHILD and holds the base model without judging.
const CHILD_EXCLUDED =
  /[\\/](?:extensions[\\/]lore|packages[\\/](?:prompt-coach|influencer|skill-select))[\\/]/;

export function keepChildExtension(extension) {
  const where = `${extension?.resolvedPath ?? extension?.path ?? ""}`;
  return !CHILD_EXCLUDED.test(where);
}
