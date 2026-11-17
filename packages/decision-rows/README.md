# pi-decision-rows

Show the decisions this collection saves, but never shows, as one-line rows in
the pi transcript. Expand tool output (`ctrl+o` by default) to see the details
under each row.

Several packages record a judgement with `pi.appendEntry()`. Those entries stay
in the session file and never enter model context, so without a renderer they
are invisible. This package registers a renderer for each of them with
`pi.registerEntryRenderer()`. Rendering is display-only: the entries still do
not reach the model, and nothing new is written.

## Rows

By default a row is drawn only when the entry says something changed or went
wrong. Measured over 35 recent sessions (123 prompts), there were about 30 Jev
entries per prompt, almost all of them routine answers, and most playbook entries
said no playbook was loaded. Drawing all of them would bury the conversation.
Guardrail and done-gate answers are the exception: each one decides something
you see (a tool call allowed or stopped, a "done" claim checked), so their rows
show the scores. A collapsed Jev row gives one number per question, the
probability or score; expanded rows add confidence and latency.

| Entry | Written by | Drawn by default | Collapsed row |
| --- | --- | --- | --- |
| `router-decision` | router | escalated, stepped down, forced, failover, judge failed | `router escalated → claude-opus-5-5@high · difficulty 0.72 · frontier` |
| `router-playbook` | router | a playbook was loaded or pinned | `router playbook debug` |
| `jev-decision` | guardrail, done-gate, safe-compact and other Jev callers | every guardrail and done-gate answer; any failed call; Jev reporting a model other than the tuned one | `jev guardrail · destructive 0.08, intent_mismatch 0.59, blast_radius 0.88, credentials 0.05` |
| `verifier-verdict` | subagents | always | `verifier verified · at 0123456789ab` |
| `prompt-coach-decision` | prompt-coach | always | `prompt-coach rewritten · intent 0.81 · gpt-5.6-terra` |

Expanded rows add the stored numbers: models, thresholds, context size, latency,
per-question Jev scores, redaction counts, the verifier's patch id and base.

## What is never printed

- prompt-coach stores your original prompt, the rewrite, the text it placed, a
  repository probe and the names of files it read. None of these are shown: the
  row gives the action, the intent probability, the model, and counts.
- A Jev entry has no prompt or state to show. Choices are printed as the index
  the ledger stores (`choice #1`), never as a criteria label.
- Every printed string is stripped of control characters and cut to 80
  characters, so a stored value cannot repaint the terminal.

## Settings (environment)

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_DECISION_ROWS` | on | `0`/`off` draws no rows. `all` draws every entry, including held router decisions, unloaded playbooks and routine answers from other Jev callers such as safe-compact and diagnosis-nudge. |

## Requirements

`pi.registerEntryRenderer` arrived in pi 0.80.4, before this collection's 1.4.0
minimum. On a host without it the package registers nothing.

## Limitations

- pi puts a blank line above every custom entry it draws, so a row takes two
  lines of transcript.
- A renderer decides when the entry is added whether there is anything to draw.
  An entry hidden by the default filter does not appear when you expand tool
  output; set `PI_DECISION_ROWS=all` and `/reload` to see it.
- Rows show only in the interactive TUI. Print, JSON and RPC modes ignore them.
