// child-policy.mjs — inline child-session extension: bash allowlist / block writers.

import { blockedBashCommand } from "../plan-mode/bash-policy.mjs";

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
      pi.on("tool_call", async (event) => evaluateChildToolCall(event, { allowlistBash, blockWriters }));
    },
  };
}
