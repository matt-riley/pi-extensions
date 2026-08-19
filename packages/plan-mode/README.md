# pi-plan-mode — Codex-like Plan Mode for Pi

Adds a read-only `/plan` collaboration mode: the agent explores your repo,
asks decision questions, and produces a **Markdown plan file you review and
edit before implementation** — the same review-before-do loop Copilot CLI's
plan mode gives you.

## Usage

```text
/plan <prompt>      plan the request (read-only); /plan approve starts implementation
/plan               status (state + plan file path)
/plan approve       approve the written plan: leaves plan mode, restores tools,
                    and tells the agent to implement the plan file
/plan edit          edit the plan in the editor dialog (Ctrl+G hands off to $EDITOR)
/plan exit | off    cancel plan mode without implementing
```

Keyboard and CLI:

```text
ctrl+alt+p          toggle plan mode on/off
ctrl+alt+e          edit the plan file (same as /plan edit)
pi --plan           start pi already in plan mode
```

While plan mode is active:

- **Tools are restricted** to `read`, `bash`, `plan_mode_question`, and
  `plan_mode_complete`; **any other tool call is blocked**, and your previous
  tool set is restored on exit.
- **Mutating tools are blocked** (`edit`, `write`, `update_plan` and anything
  outside the plan toolset), and `bash` runs under a mutator guard: redirects
  and known mutating commands/chains (see `bash-policy.mjs`) are rejected.
  This is an accidental-mutation guardrail, not a sandbox.
- A **footer status** ("plan (read-only)") and a **widget** (mode + plan file
  path) keep the state visible while active; both clear on exit.
- The agent explores read-only, asks questions with
  `plan_mode_question` when a preference or tradeoff matters, and finishes
  with `plan_mode_complete({ plan })`, which:

  1. validates the plan,
  2. writes it to **`PLAN.md`** in the working directory
     (revisions overwrite in place unless the file was edited — then they land
     in `PLAN.md.2`, `.3`, … so your edits are never clobbered; writes are
     atomic), and
  3. ends the turn.

You then read/edit `PLAN.md` — directly, via `/plan edit` or `ctrl+alt+e`
(Ctrl+G inside the dialog opens your `$EDITOR`; the plan is written back when
you close it), or in any editor of your choice — and run `/plan approve`. That
ends plan mode, restores your tools, and automatically tells the agent to
implement the plan file — no separate exit/implement step. The file is the
durable artifact — it survives compaction and is the implementation handoff,
so plan mode needs no in-memory plan retention.

## Notes and non-goals (for now)

- Plan mode state is not persisted across pi restarts; the plan file is the
  source of truth.
- `/plan start` still exists as a no-prompt way to enter plan mode, but
  `/plan <prompt>` is the intended entry point.
- No export/save/fresh-session handoff, settings file, or tool pre-selection
  menu yet — say the word if you want any of them.
- The bash guard is a fail-open blocklist: it blocks high-confidence mutating
  commands but is not a sandbox, and a few read-only commands are false
  positives (e.g. `grep -n "<div" file`, `git branch -a`). The model is
  additionally instructed not to mutate.

## Development

```sh
npm test          # node --test against bash-policy.mjs and plan-file.mjs
npm run check     # syntax-check entrypoints + tests
```
