# pi-plan-mode — Codex-like Plan Mode for Pi

Adds a read-only `/plan` collaboration mode: the agent explores your repo,
**grills you for the full scope** (design-tree rounds of decision questions,
each with a recommended answer), and only then produces a **Markdown plan
file you review and edit before implementation** — the same review-before-do
loop Copilot CLI's plan mode gives you.

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

- **Tools are restricted** to `read`, `bash`, `grep`, `find`, `ls`,
  `repo_map`, `code_search`, `file_outline`, `find_definition` (from
  `pi-code-search`),
  `plan_mode_question`, `plan_mode_complete`, `plan_fetch_url`, and
  `web_search`; **any other tool call is blocked**, and your previous tool
  set is restored on exit.
- **Mutating tools are blocked** (`edit`, `write`, `update_plan` and anything
  outside the plan toolset), and `bash` runs under a **fail-closed read-only
  allowlist** (see `bash-policy.mjs`, modeled on the reference plan-mode
  extension): known mutators are blocked outright, only explicitly
  allowlisted read-only commands pass (with per-command rules that forbid
  dangerous flags such as `sed -i`, `find -exec/-delete`, `tar -x`,
  `git push`, `npm install`), and anything else is blocked because it is not
  known to be read-only. Redirects and command substitution are rejected. This
  is a guardrail, not a sandbox: deliberately scripted mutations (e.g. an
  `awk` program that writes a file) are out of scope.
- **Read-only web access** via `plan_fetch_url` and `web_search`:
  `plan_fetch_url` fetches an http(s) URL and returns clean readable content
  — markdown by default with title/URL metadata, capped at 40k characters;
  `web_search` runs a keyless web search (DuckDuckGo by default, or a
  configured SearXNG instance) returning titles/URLs/snippets, up to
  10 results). Both are powered by the same zero-dependency engine as
  [`pi-web-fetch`](../web-fetch): browser-like headers, redirect following,
  alternate-content fallback, and the `gh` CLI for GitHub URLs when
  available. 20s timeout and an Esc-cancellable request (search uses
  web-fetch's 15s default). These are the sanctioned network paths:
  `curl`/`wget` stay blocked by the bash allowlist, so web research can't
  double as a mutation or exfiltration vector. `web_search` resolves from the
  pi-web-fetch extension — if that extension is unloaded, drop it from
  `PLAN_TOOLS` in `index.ts`.
- A **footer status** ("plan (read-only)") and a **widget** (mode + plan file
  path) keep the state visible while active; both clear on exit.
- The agent explores read-only, then **grills you for the full scope**: it
  works the request as a design tree and asks each round's frontier questions
  — numbered, with options and a recommended answer via `plan_mode_question`
  — until every decision is settled and nothing is silently assumed. A
  round's questions come back as one dialog at a time (they are serialized so
  concurrent question calls never stack dialogs and hang the turn); answer
  each and the agent gets the whole round back. Only
  then does it finish with `plan_mode_complete({ plan })`, which:

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
- The bash guard is a **fail-closed read-only allowlist**: plan-mode bash is
  limited to inspection commands (see `bash-policy.mjs`). Test runners
  (`npm test`, `go test`), script interpreters (`node`, `python3 -c`),
  installs, and network tools are blocked in plan mode — exit plan mode to run
  them; use `plan_fetch_url` / `web_search` for web research instead. The model is
  additionally instructed not to mutate.

## Development

```sh
npm test          # node --test against bash-policy.mjs, plan-file.mjs, dialog-queue.mjs
npm run check     # syntax-check entrypoints + tests
```
