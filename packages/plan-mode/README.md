# pi-plan-mode — plan before editing

Work through a change before the agent starts editing. In `/plan`, the agent
explores the repository with read-only tools, asks you to settle open decisions,
and writes a Markdown plan for you to review. You decide when implementation
starts.

## Usage

```text
/plan <prompt>      plan the request (read-only); /plan approve starts implementation
/plan               status (state + plan file path)
/plan approve       approve the written plan: leaves plan mode, restores tools,
                    and tells the agent to implement the plan file
/plan check         optional fresh-context comprehension check (see below)
/plan edit          edit the plan in the editor dialog (Ctrl+G hands off to $EDITOR)
/plan exit | off    cancel plan mode without implementing
```

Keyboard and CLI:

```text
ctrl+alt+p          toggle plan mode on/off
ctrl+alt+e          edit the plan file (same as /plan edit)
pi --plan           start pi already in plan mode
```

## What happens in plan mode

The footer shows `plan (read-only)`, and a widget shows the plan file path.
The agent inspects the code and asks decision questions with options and a
recommended answer. Questions appear one dialog at a time, even when the agent
asks several together.

When the plan is ready, `plan_mode_complete` validates it, optionally asks
TypeSafe to check its steps, and writes **`.pi/PLAN.md`** in the current working
directory. Writes are atomic. If you have edited the existing plan, revisions
use `.pi/PLAN.md.2`, `.3`, and so on rather than overwriting your changes.
The tool then ends the turn; it does not start implementation.

Review the file directly or through `/plan edit`. Run `/plan approve` when you
want the agent to implement it. That restores the previous tools and submits
the plan for implementation; `/plan exit` leaves without doing so.

### Available tools

Tool access is enforced by `tool-policy.mjs`, not just instructions to the model:

- Local read-only tools registered by this collection are allowed: code search,
  `skill_select`, and `view_context`. Outside tools cannot grant themselves
  access with `readOnlyHint: true`; `readOnlyHint: false` blocks access.
- The mode activates its three deferred tools: `plan_mode_question`,
  `plan_fetch_url`, and `plan_mode_complete`. Only the last can write, and only
  to the plan file. Other tools whose exposure is not `direct` stay inactive.
- `read`, `bash`, `grep`, `find`, `ls`, and `lore_recall` retain their existing
  access. An unloaded extension's tool name grants nothing.
- Web research uses `plan_fetch_url` and `web_search`. `web_fetch`,
  `typesafe_ask` and `read_relevant` are not offered as alternate paths.
- Other calls, including `edit`, `write` and `update_plan`, are blocked.

Bash uses the shared **fail-closed read-only allowlist**. Unknown commands,
redirects, command substitution and mutating flags are rejected, including
`sed -i`, `find -exec/-delete`, `tar -x`, `git push` and `npm install`.
This is a guardrail, not a sandbox: a deliberately file-writing `awk` program,
for example, is outside its protection.

`plan_fetch_url` returns readable HTTP(S) content with title/URL metadata,
capped at 40,000 characters by default. It has a 20-second timeout and supports
Escape cancellation. `web_search` returns up to ten titles, URLs and snippets,
using web-fetch's 15-second default. Both use the
[web-fetch engine](../web-fetch/README.md): browser-like headers, redirects,
alternate content, and `gh` for GitHub URLs. Search requires that extension to
be loaded. `curl` and `wget` stay blocked by the bash policy.

### The plan check

The optional TypeSafe review asks two questions about every step: how will it
be verified, and which callers or consumers does it affect? `plan-review.mjs`
splits the plan by list items, then headings, or treats the whole plan as one
step. One request checks them all and appends any gaps:

```
## Plan check

TypeSafe read the steps above and found:

No verification named:
- step 3 — Add a cache layer between the loader and the store

Affected callers not identified:
- step 5 — Rename config.timeout to config.deadline

This is a reading of the plan text, not of the code. Edit the step or say why it holds.
```

It costs one request with an 8-second timeout and is never allowed to block the
plan: no key, a failed request or an unusable answer means the plan is written
exactly as submitted. A plan where every step holds up gets a one-line "every
step names its verification" instead of silence, so the check is visible when it
passes too.

### `/plan check` (comprehension)

Before `/plan approve`, you can run **`/plan check`**: one hidden read-only
child (via `subagents/spawn.mjs` `runChild`, pinned to **`cross-family`**, no
fleet widget or panes) reads **only** the plan file path — it never sees the
planning chat — and may read files the plan names. It must restate the plan under
**What the plan changes** and **How it will be done**, then list **Gaps**
(undefined terms, unstated assumptions, missing verification). TypeSafe (Jev) then
answers two yes/no questions: whether the restatement matches the plan goal, and
whether any step depends on something the plan never states. The result is
appended to the plan file as **`## Plan comprehension check`**, and Jev's answers
are logged in the usual **`jev-decision`** ledger like the step review above.

Cost: **one child run** (up to 8 turns, 120s timeout) plus one Jev request (12s).
It is **opt-in and advisory** — it never blocks or changes `/plan approve`.

Hard failures are reported honestly:

- A failed, timed-out, or aborted reader is **`not run`** with the reason, never
  "no gaps".
- A missing TypeSafe key or a Jev failure still shows the reader's restatement
  and gaps; the verdict is **`not run`**, never a pass.
- With no plan file yet, `/plan check` says so and does nothing.

You then read/edit `.pi/PLAN.md` — directly, via `/plan edit` or `ctrl+alt+e`
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
- There is no export command, fresh-session handoff, settings file, or tool
  pre-selection menu.
- The bash guard is a **fail-closed read-only allowlist**: plan-mode bash is
  limited to inspection commands (see `shared/bash-policy.mjs`). Test runners
  (`npm test`, `go test`), script interpreters (`node`, `python3 -c`),
  installs, and network tools are blocked in plan mode — exit plan mode to run
  them; use `plan_fetch_url` / `web_search` for web research instead. The model is
  additionally instructed not to mutate.

## Answering a question the context already settles

`plan_mode_question` is where a discoverable question becomes a dialog, so it
is also where that can be enforced: the tool, not the prompt. Before showing a
dialog it asks Jev one thing — which option the agent's **own** `recommended`
answer names — and answers only when that reading lands on the recommendation
at 0.9 confidence or above. A question is a dialog because the agent was in
two minds about it; a reading that agrees with the recommendation was not
going to be news.

The decision is about the agent, not the user, and it is conservative: a
preference, a cost, an interface others rely on, a deletion, no recommended
answer, an unfamiliar option, a reading that disagrees or is unsure all ask
the user exactly as before. That list is deterministic, in `ask-gate.mjs`,
not the judge's opinion. When it does answer, the user sees one line naming
the reason and the agent is told the answer was inferred rather than given, so
the plan cannot claim the user chose it.

A first version asked the judge whether "the context settles this" and got
0.32 and 0.57 on the most inferable questions in `node scripts/judge-live.mjs`
— the right answer to the wrong question, since one line of request is not
context. Reading the recommendation needs nothing the tool does not already
have.

`PI_PLAN_JUDGE=off` disables it, and without a TypeSafe key it is skipped
silently. Same failure mode as everywhere else: a slow or missing judge means
the dialog happens, never that a question is answered by nobody.

## Development

```sh
npm test          # node --test against shared/bash-policy.mjs, plan-file.mjs, dialog-queue.mjs
npm run check     # conventions, types, lint, format, unused code, tests
```
