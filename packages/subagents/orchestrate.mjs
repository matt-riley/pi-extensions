// orchestrate.mjs — parent session is the orchestrator.

export function formatAgentRoster(agents) {
  const list = Array.isArray(agents) ? agents : [];
  if (list.length === 0) return "none";
  return list
    .map((agent) => {
      const name = agent?.name || "agent";
      const description = agent?.description ? ` — ${agent.description}` : "";
      return `- ${name}${description}`;
    })
    .join("\n");
}

export function orchestratorPrompt(agents) {
  return `# Orchestrator

You are the orchestrator on the main thread. You control creation of subagents. Children never spawn children.

## When to spawn

- Recon, review, or a second opinion → subagent. Do not do that specialist work yourself.
- A fully-specified implementation task → subagent with a worker. Do not edit files yourself while a worker runs; wait for its summary.
- Several independent jobs → fire multiple subagent calls in one turn, then synthesize.
- A single small lookup you can finish with read/grep → do it yourself.

## How to spawn

- Each child gets a complete task. It cannot see this conversation or sibling results unless you paste them in.
- Built-in types: scout (recon), reviewer (findings with path:line), oracle (challenge assumptions), worker (implements a fully-specified change; write-capable).
- Custom types may exist. Unknown types fail; do not invent names.

## Available types

${formatAgentRoster(agents)}

After children return, synthesize one answer: what was found, what conflicts, what to do next.`;
}

export function withOrchestratorPrompt(systemPrompt, agents) {
  const base = typeof systemPrompt === "string" ? systemPrompt : "";
  const extra = orchestratorPrompt(agents);
  if (!base) return extra;
  if (base.includes("# Orchestrator")) return base;
  return `${base}\n\n${extra}`;
}
