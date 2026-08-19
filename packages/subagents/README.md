# pi-subagents

**Off by default.** The `subagent` tool is inactive and no orchestrator text
reaches the model until you opt in. When you do, the **main session is the
orchestrator**: it decides which specialists to create, fires N concurrent
`subagent({ agent, task })` calls, and synthesizes. Children never spawn
children. Each child is a fresh `createAgentSession()` with its own context.
Results come back truncated.

## Use it

```text
/subagents on         opt in — activates the tool and the orchestrator brief
/subagents off        opt out (running children keep going; new spawns stop)
/subagents            pick a running or queued child, then steer or stop
```

```text
Use scout and reviewer in parallel: scout the auth flow, reviewer the tests.
```

A status widget above the editor lists the fleet. It is display-only. The
enabled state lasts for the pi process (survives session switches, resets on
restart).

## Tool

```text
subagent({
  agent,            // scout | reviewer | oracle | worker | custom type
  task,             // full prompt — the child cannot see this conversation
  description?,     // 3–5 words for the widget
  max_turns?,       // 1–30, may only lower the resolved cap
})
```

Unknown or disabled types error. There is no general-purpose fallback.

## Built-in types

| Type | Job | Writes |
| --- | --- | --- |
| `scout` | Fast recon. repo_map → code_search → key files → compressed start-here. | read-only |
| `reviewer` | Findings with `path:line`, severity, evidence. No edits. | read-only |
| `oracle` | Second opinion. Challenge assumptions. Name what is missing. | read-only |
| `worker` | Implements a fully-specified change: edits files, runs named checks, reports a diff summary. | edit/write + full bash |

All inherit the parent model. Read-only types get bash restricted to plan-mode's
fail-closed allowlist. The `worker` is write-capable with prompt-level guard
rails only (stay in scope, never commit/push/install, stop early on ambiguity).

## Custom types

`.md` files with YAML frontmatter, highest wins:

1. `<cwd>/.pi/agents/*.md` — only if the project is trusted
2. `~/.pi/agent/agents/*.md`
3. shipped builtins

```markdown
---
name: writer
description: Implements a small approved change
tools: read, edit, write, bash
---

You implement the task. Do not spawn other agents.
```

A declared `tools:` list is honored for every agent (builtin or custom) and
defines the child's exact toolset. Files that omit `tools:` get the read-only
default (full toolset minus writers, allowlisted bash). Custom files that list
`bash` get full bash; listing `edit`/`write` makes the agent write-capable.
Builtins are read-only **unless** they declare `edit`/`write` in `tools:`.
`enabled: false` hides that name (including a builtin).

v1 frontmatter: `name`, `description`, `tools`, `model` (exact `provider/id`),
`thinking`, `max_turns` (1–30), `enabled`.

## Limits

- Max 4 running; extras queue.
- 30 turns, wrap-up steer, then 2 grace turns, then abort.
- Last assistant text, capped at 50 KB, plus usage stats.
- Always fresh context. No resume, no background, no nested orchestrator, no worktrees.
- Children load host extensions except this package, and never get `subagent`.
- The orchestrator brief (roster + spawn rules) is appended to the system
  prompt only while subagents are on — never otherwise.

## Notes

- `/plan` is unchanged. Subagents do work; plan-mode decides work. While plan
  mode is active the `subagent` tool is not callable (its read-only toolset
  excludes it).
- In-process spawn uses the host SDK (`createAgentSession`). That is not a
  new npm dependency.
- Recursion guard: `PI_SUBAGENT_CHILD=1` during child bind, plus
  `excludeTools: ["subagent"]`.
