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
/plan exit | off    cancel plan mode without implementing
```

While plan mode is active:

- **Tools are restricted** to `read`, `bash`, `plan_mode_question`, and
  `plan_mode_complete`; your previous tool set is restored on exit.
- **Mutating tools are blocked** (`edit`, `write`, `update_plan`), and `bash`
  runs under a mutator guard: redirects and known mutating commands/chains
  (see `bash-policy.mjs`) are rejected. This is an accidental-mutation
  guardrail, not a sandbox.
- The agent explores read-only, asks questions with
  `plan_mode_question` when a preference or tradeoff matters, and finishes
  with `plan_mode_complete({ plan })`, which:

  1. validates the plan,
  2. writes it to **`PLAN.md`** in the working directory
     (revisions overwrite in place unless the file was edited — then it lands
     in `PLAN.md.2`, `.3`, … so your edits are never clobbered), and
  3. ends the turn.

You then read/edit `PLAN.md` and run `/plan approve`. That ends plan mode,
restores your tools, and automatically tells the agent to implement the plan
file — no separate exit/implement step. The file is the durable artifact — it
survives compaction and is the implementation handoff, so plan mode needs no
in-memory plan retention.

## Notes and non-goals (for now)

- Plan mode state is not persisted across pi restarts; the plan file is the
  source of truth.
- `/plan start` still exists as a no-prompt way to enter plan mode, but
  `/plan <prompt>` is the intended entry point.
- No export/save/fresh-session handoff, settings file, tool pre-selection
  menu, or statusline integration yet — say the word if you want any of them.

## Development

```sh
npm test          # node --test against bash-policy.mjs
npm run check     # syntax-check entrypoints + tests
```
