# pi-agents: create or improve an `AGENTS.md`

`/agents [dir]` starts a repository-aware initialization task using the active
agent and its normal tools. With no argument it uses the session working directory.

```
/agents              # here
/agents packages/api # a named directory
```

The argument is one path, so spaces need no shell quoting. Relative paths resolve
against the session working directory. If the agent is busy, the task is queued
as a follow-up. This uses the current model and its usual provider costs and
permissions; dispatching the task does not mean the file has already been edited.

## What it writes

The agent inspects existing instructions, README/contributor docs, manifests,
lockfiles, CI, build/test configuration, and representative code. It creates or
improves the selected directory’s `AGENTS.md` with concise, project-specific
instructions, guided by the [AGENTS.md examples](https://agents.md/#examples):

- Development environment and setup tips, including the actual package manager.
- Useful build, test, lint and type-check commands with their working directory.
- Testing instructions, code conventions, and supported commit/PR guidance.
- Project overview, important structure and security gotchas where relevant.

These are topics to investigate, not mandatory headings or policies to invent.
Non-JavaScript projects work too; the command no longer just lists npm scripts.
The reference topics are included in the request, so fetching the site is not
required at runtime.

## Existing guidance

The request tells the agent to read the complete existing file and preserve useful
rules, commands, caveats and user edits. A Commands heading no longer prevents
improvement. It should correct guidance only with repository evidence, avoid
duplicating inherited instructions, and leave an already useful file unchanged
when there is nothing useful to add. It must re-read before editing and review
the diff for lost guidance. Editorial quality and preservation depend on the
active model following these instructions; this is not a byte-preserving append.

Case-insensitive matching targets `AGENTS.MD` in place. A symlink is resolved and
the request names its target as the only editable file, keeping the link intact.
The extension itself does not write a scaffold or replace existing content.
Atomic-write behavior depends on the tools used by the agent.

## Scope and failures

Only the selected `AGENTS.md` (or its resolved symlink target) should change—not
project code, other context files or global configuration. Relevant ancestor and
nested instructions may be read for context, but are not rewritten. No commits,
deployments, dependency installations or policy changes are requested.

Missing/non-directory paths, unreadable instructions and broken symlinks are
reported before starting a task. An `AGENTS.override.md` is reported instead of
editing a file it shadows. Write failures are reported by the agent through its
normal tools. File edits and model judgment are not enforced by a separate
extension-specific sandbox.
