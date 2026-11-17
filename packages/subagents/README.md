# pi-subagents

Delegate separate pieces of work to child agents: one can explore the code while
another reviews the tests. The main session assigns the tasks and brings their
results together.

**Off by default.** Until you opt in, the `subagent` tool stays inactive and its
instructions stay out of the model's prompt. Each child starts with fresh context,
not a copy of your conversation, and cannot spawn more children. Returned text
is capped; full transcripts are saved for later inspection.

## Use it

```text
/subagents on         opt in — activates the tool and the orchestrator brief
/subagents off        opt out (running children keep going; new spawns stop)
/subagents            pick a running or queued child, then steer or stop;
                      also lists worktrees kept because a child left work in them
```

```text
Use scout and reviewer in parallel: have the scout trace authentication and the reviewer inspect its tests.
```

A status widget above the editor lists the fleet. It is display-only. While
enabled, the footer status line shows a live `subagents: N running · M queued`
count. The enabled state lasts for the pi process (survives session switches,
resets on restart).

## Tool

```text
subagent({
  agent,            // scout | reviewer | oracle | worker | researcher | custom type
  task,             // full prompt — the child cannot see this conversation
  description?,     // 3–5 words for the widget
  max_turns?,       // 1–30, may only lower the resolved cap
  timeout_ms?,      // wall-clock cap in ms (up to 2h), may only lower the resolved cap
  model?,           // "provider/id" or "cross-family"; overrides the type's default
  acceptance?,      // [{criterion, command}] parent-specified checks
  isolation?,       // "worktree": run in its own git worktree (below)
})
```

Unknown or disabled types error. There is no general-purpose fallback. Every
result carries an `id:` line; `swarm_report` reads finished results by it.

## Worktrees

`isolation: "worktree"` runs the child in its own git worktree, so writers can
run in parallel and an adversary can write repro scripts without touching your
tree.

- The worktree is created when the child starts, on a new branch
  `pi-subagent/<id>-<hex>` at your current HEAD. Your uncommitted state is copied
  in: tracked changes (staged and unstaged) as one binary patch, untracked files
  that are not ignored as copies. A patch that does not apply is an error, and
  nothing runs; the child never silently starts from a clean tree.
- Worktrees live under `~/.pi/agent/subagent-worktrees/<repo-hash>/`, never inside
  the repository, so the parent's `drift` and `done-gate` do not see them.
- The child's working directory is your cwd mapped into the worktree. The
  result names the worktree path, branch, base commit and commit count, and its
  `changes:` lines are measured from the tree the child started with, so your
  copied changes are not attributed to it.
- Nothing is merged back. Read the result, then graft what you keep by hand
  (`git -C <worktree> diff`, or cherry-pick a child's commits).
- At session shutdown a worktree is removed with its branch only when the child
  left no commit and no change. Otherwise it is kept and `/subagents` lists it;
  `git worktree remove <path>` deletes it once grafted.

## Panels

`review_panel()` (deferred, read-only) returns
`{ seats: string[], judge?: string, notes: string[] }` for skills that fan out
across models (`interrogate`, `arena`). Pass each seat as a child's `model`.

- **One seat per vendor.** Seats are distinct vendors as `modelFamily` reads them
  from the model id, so `claude-fable-*` and `claude-opus-*` share one seat: two
  models from one vendor tend to share its blind spots. At most three seats.
- **Seats** come from `roles.panel` in `~/.pi/agent/router.json`, in order, then
  from the `frontier`, `mid` and `base` tiers. Only authenticated models count.
- **The judge** is the first `roles.judge` entry (else the panel list, then the
  tiers) that is authenticated and outside the parent's vendor. With the parent
  on `router/auto`, the vendor comes from its last physical model.
- A panel with fewer than two vendors, and a missing judge, come back as notes.
  Skills report them: a one-vendor panel is the same blind spots repeated.

```json
{
  "frontier": ["claude-opus-5-5", "gpt-5.6-sol"],
  "roles": {
    "panel": ["claude-fable-5-2", "gemini-4-carbon", "gpt-5.6-sol"],
    "judge": ["claude-opus-5-5", "gemini-4-carbon"]
  }
}
```

The router ignores `roles`; only this package reads it.

## Swarm results

`swarm_report({ slices: [{ id, slice?, required? }], expect_sha? })` (deferred,
read-only) aggregates finished children by the `id:` on their results, from the
child's own final text rather than a summary of it.

- A slice is a **gap** when its child did not finish cleanly, when the first
  non-blank line does not open with `PASS`, `ISSUES` or `BLOCKED`, or, with
  `expect_sha`, when the text does not name that commit (full or a 7+ prefix).
- Overall is `PASS` only when every required slice passed; with none marked
  required, all are. A gap in a required slice makes it `INCOMPLETE`, and so does
  an empty swarm. Otherwise `ISSUES`. Gaps in optional slices are still listed.
- Only the 50 most recent finished children of this session are kept.

## Briefs and when to delegate

A child sees only its brief, so the orchestrator prompt, the tool text and the
`scout` and `oracle` prompts all say the same things.

A brief has five parts: the goal in one sentence; the context (the plan this job
is part of, concrete paths and symbols, error text, decisions already made, and
the conventions to follow); constraints; the deliverable; and how to verify, which
means the exact command and the output that counts. The orchestrator is told to
reread it as someone who has seen nothing else, and to replace "as discussed" or
"the file above" with the decision or the path.

Two jobs stay with the orchestrator: anything it can finish in one reply, and its
whole assignment. It delegates separable pieces and keeps the plan, the
integration and the final answer. When children return, the user cannot see what
they wrote, so the orchestrator summarises each result in a sentence or two,
with paths, before giving one answer.

`scout` and `oracle` read the brief as the caller's account. If it points at
something they cannot see, they say so on the first lines and do not guess. They
do their own task rather than handing it on, and still never edit files or spawn
agents. The `scout` also names the search or command behind a claim that
matters, so the parent can repeat it.

These are prompt rules, so a model can still ignore them. The preflight judgment
below catches a brief that leans on unseen context, and the stale-path check
catches a path that no longer exists.

## Built-in types

| Type | Job | Writes |
| --- | --- | --- |
| `scout` | Fast recon. repo_map -> code_search -> key files -> compressed start-here. | read-only |
| `reviewer` | Reviews the diff (not the whole file). Findings with `path:line`, severity, verdict. No edits. | read-only |
| `verifier` | Independently reproduces a change. Runs the build, tests, and artifact, and reports observed evidence. | write-capable (bash unrestricted) |
| `oracle` | Second opinion. Challenge assumptions. Name what is missing. | read-only |
| `worker` | Implements a fully-specified change: edits files, runs checks, reports a diff summary. | edit/write + full bash |
| `adversary` | Tries to break a change; reports only failures it reproduced, as commands `rerun_findings` reruns. Writes scratch files under `.adversary/` only; run it with `isolation: "worktree"`. | write + full bash |
| `researcher` | Web/docs research with cited sources and a concise brief. | read-only |
| `comment-auditor` | Classifies each comment in the diff (or a named path) as keep, delete, or encode, naming the type, test or lint that would enforce it. | read-only |

`reviewer`, `oracle` and `adversary` default to `model: cross-family`: the strongest model
listed in `~/.pi/agent/router.json` (frontier, then mid, then base) that is
authenticated and from a different family than the parent (families are read
from the model id, so `openai/gpt-*` and `openai-codex/gpt-*` count as one). A
reviewer on the author's own family tends to share its blind spots. With
nothing eligible, they inherit the parent and the result carries a note saying so.
When the parent runs `router/auto`, family is taken from the router's last physical
model (or the configured base before the first route). The rest inherit the parent model. A per-call `model` parameter (`provider/id` or
`cross-family`) overrides the type's default. Read-only types get bash restricted to plan-mode's
fail-closed allowlist. The `worker` is write-capable with prompt-level guard
rails only (stay in scope, never commit/push/install, stop early on ambiguity).
Builtins are pre-tuned: `scout` (10 turns, low thinking), `reviewer` (15/high),
`verifier` (25/high), `adversary` (25/high), `oracle` (8/high), `worker` (30/high), `researcher` (12/high).

## Custom types

`.md` files with YAML frontmatter, highest wins:

1. `<cwd>/.pi/agents/*.md`: only if the project is trusted
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
defines the child's exact toolset. Files that omit `tools:` get an explicit
read-only allowlist (`read`, `grep`, `find`, `ls`, `bash`, the code-search tools,
and the web tools), never a blocklist, so no future mutating tool can leak in.

Full bash is granted **only** to write-capable agents: those that declare
`edit`/`write` in `tools:`. Every other agent (builtin or custom, listed or
not) runs bash under the read-only allowlist, so a "read-only" agent cannot
`rm -rf` its way around missing write tools. `enabled: false` hides that name
(including a builtin).

Copy-paste examples live in [`examples/custom-agents/`](./examples/custom-agents/):
a write-capable `writer` and a read-only `docs-auditor`. Drop them into
`~/.pi/agent/agents/` (or `<cwd>/.pi/agents/`) to use them as `subagent` types.

v1 frontmatter: `name`, `description`, `tools`, `model` (exact `provider/id`, or `cross-family`),
`thinking`, `max_turns` (1–30), `timeout_ms` (ms), `enabled`.

## Limits

- Max 4 running; extras queue. One write-capable child in your tree runs at a time (later writers wait
  their turn in arrival order), so a writer's change list is its own. Read-only children and writers in
  their own worktree stay parallel.
- 30 turns, wrap-up steer, then 2 grace turns, then abort; plus a 30-minute
  wall-clock timeout (frontmatter/`timeout_ms` can adjust) so a hung tool call
  cannot block the parent forever.
- Last assistant text, capped at 12 KB (head + tail kept), plus usage stats. Every run's
  full transcript is written to `~/.pi/agent/subagent-runs/*.jsonl` (newest 200 kept) and
  its path is on the result. A child that is stopped, times out or aborts returns its
  recent assistant text and tool trace instead of an empty message.
- A "start converging" steer at ~70% of the turn cap (caps of 5+), before the wrap-up steer. Child token usage is
  attributed to the session (`usage` on the tool result).
- Child runtime failures (error / timed out / aborted) return as normal content,
  never `isError`, so pi does not blindly auto-retry the same failing spawn.
- Always fresh context. No resume, no background, no nested orchestrator.
- Children load host extensions except this package and the interactive-only ones
  (`lore`, `prompt-coach`, `skill-select`), and never get `subagent`.
  The router loads on purpose so children that inherit `router/auto` still register
  the virtual model; pinned or cross-family children keep their physical model.
- The orchestrator brief (roster + spawn rules) is appended to the system
  prompt only while subagents are on, never otherwise.

## Notes

- `/plan` is unchanged. Subagents do work; plan-mode decides work. While plan
  mode is active the `subagent` tool is not callable (its read-only toolset
  excludes it). Plan mode has its own narrower `plan_scout` for read-only recon (see
  [plan mode](../plan-mode/README.md#scouts)).
- In-process spawn uses the host SDK (`createAgentSession`). That is not a
  new npm dependency.
- Recursion guard: `PI_SUBAGENT_CHILD=1` during child bind, plus
  `excludeTools: ["subagent"]`.

## Stale-path check (no key needed)

Before the TypeSafe preflight, a plain existence check looks at the file paths in the task
(`src/loader.mjs`, `.github/workflows/ci.yml:12`, `/abs/path.txt`). If any no longer exist in the
working directory, the task is rejected once and the missing paths are listed, so the parent
can fix a renamed file instead of sending the child hunting. Resubmitting the identical task
runs it. URLs, globs, directories and paths the task says to create are never flagged.

## TypeSafe judgments (optional)

With a TypeSafe key (see `pi-typesafe`) three batched Jev judgments run; without one they
are skipped silently, so every path fails open.

- **Preflight** (before spawn): rejects a task once when it leans on context the child
  cannot see, or (write-capable agents) leaves a design decision open. Resubmitting the
  identical task runs it. A missing deliverable or scope is added to the child's task as a
  hint instead. Thresholds: `THRESHOLDS` in `judge.mjs`.
- **Triage** (after a clean run): `triage: answered | partial | blocked | off_task (p)`.
- **Scope check** (write-capable agents): the real `git diff` since the spawn is appended as
  `changes:`, and a warning is added when the diff likely goes beyond the task.

`node scripts/subagent-usage-report.mjs` counts spawns, fan-out, triage, tokens and lossy handoffs from local sessions (see `docs/workflow-evaluation.md`).
