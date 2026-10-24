# pi-guardrail — stop destructive tool use before it runs

A gate on `tool_call`. Four layers, cheapest first, so that the common case
costs nothing and the rare dangerous case gets a real decision.

| Layer | Decides | Cost |
| --- | --- | --- |
| Read-only fast path | `git status`, `rg`, `cat` — provably harmless | microseconds, reused from `shared/bash-policy.mjs` |
| Deterministic rules (`policy.mjs`) | delete / overwrite / history-rewrite / privilege / remote-destroy / credential shapes, against regenerable, workspace, home, system and secret targets | microseconds, no I/O, no network |
| TypeSafe judgment (`judge.mjs`) | the ambiguous band only: is this unrecoverable, beyond the request, how far would it reach, does it touch secrets | one batched `jev` request, 4 s deadline |
| Human confirm | everything above that still matters | one dialog: **Approve** / **Deny** / **Suggest an alternative** |

The catastrophic set is refused with no dialog at all — home and filesystem
roots, `.git` internals, private keys, disk wipes, credentials piped to a
network command — because a tired `Enter` should not be able to wipe `~`.

## Human authorization and control files

Recognized external effects (push, merge, publish, deploy/apply and mutating
GitHub API calls) require deterministic human approval, independently of the
semantic destruction judge. Namespaced/MCP tools without a read-only hint also
require approval; destructive hints override reader-like names. Hints are not
verified capabilities. Ordinary reads, project writes and regenerable output
remain routine.

Pi instructions (`AGENTS.md`), global settings/model/router/MCP/trust files,
installed extensions, skills, prompts and agent definitions are control files.
Project `.pi` equivalents are covered too. File tools and recognized shell
writes/redirects require approval even from inside those directories. The host
resolves symlink aliases and parent directories before choosing the scope.

Approval is **current-input only**, not a durable allowlist: the dialog shows
its target scopes and cwd. An identical shell invocation or remote tool call
may reuse approval; a file approval covers further edits of that same file,
not siblings. Different commands/targets/cwd need new approval. New user input,
session start/switch, `/guardrail revoke`, and either toggle clear grants;
pending old dialogs cannot grant permission to the new input. Concurrent
identical requests share one dialog. No UI, cancellation or denial refuses the
call. Catastrophic blocks are evaluated before grants and cannot be approved.
CLI targets are the displayed invocation, not cryptographically pinned remote
identities: changing CLI config or obfuscated/runtime-generated actions needs
an actual sandbox or stronger service-side permissions.

## The dialog

```
🛑 Guardrail

bash: rm -rf ~/Documents/projects/personal/other-repo

delete (rm) on home

➡️ Recommended: Deny

  1. ✅ Approve
  2. ⛔ Deny
  3. ✏️ Suggest an alternative
```

`Recommend` is shown only when the judgment is unambiguous (`recommendedAction`
uses stricter bounds than routing does); a prompt that always recommends
something teaches people to click it. **Suggest an alternative** opens a text
input and returns the answer inside the block reason — the only channel back to
the model — so "delete only ./dist" comes back as an instruction, not a retry
of the original.

Dialogs share plan mode's FIFO queue (`shared/dialog-queue.mjs`): two flagged
calls in one assistant message must not stack two prompts.

## Historical measured behaviour

The replay figures below predate scoped authorization/control-file protection;
they are not a measurement of the current interruption rate.

`node scripts/replay-corpus.mjs` replays every bash/edit/write call in
`~/.pi/agent/sessions` and reports what the guardrail would have done:

| | 20,574 mutating calls (163 sessions, as of 2026-10) |
| --- | --- |
| allow | 98.15% |
| judge | 1.32% (~1 per 76 mutating calls) |
| confirm | 0.52% (~1 dialog every two sessions) |
| block | 0.01% (3 calls) |

The aggregate hides where it matters. Replaying the one session that set up
this repo's oxlint/oxfmt/knip/fallow config — a session running from a *parent*
directory while working in `~/.pi/.../pi-extensions` — went from 15 flagged
calls (5.1%, eight of them dialogs about writing `knip.json`, `.fallowrc.json`,
`.oxlintrc.json` and `package.json`) to **1 flagged call (0.3%)**, and that one
is a silent judgment rather than a prompt. Three bugs, each now a regression
test: a `cd` did not make the directory it entered part of the workspace; `~`
resolved to a literal directory named `~`; and inline JS was read with the shell
rules, so every `=>` looked like a redirect.

What the band is made of, over all 271: 210 deletions (78%), 48 git history
operations, 11 credential reads, 2 inline-node destructive runs.

The policy layer only decides which calls *reach* the judge; `--judge 150` is
the shadow trial for the other half. It judges a strided sample of those calls
and keeps the raw signals (`--judge-json`), so a candidate threshold is scored
offline by the production router and the judgments are paid for once.

The sample says the intent line was doing almost all the interrupting. 64 of 150
scored 0.70–0.85 on `intent_mismatch` and were ordinary work — `go test -race
./...`, `pnpm build`, `rm -f` of a tracked file, a heredoc, a Blender render —
while `destructive` sat below 0.5 on 127 and `blast_radius` at 2 or above on
2. At `intentMismatch: 0.6` the judge confirmed 92% of its own band; the
interruption rate was **1.75% of mutating calls (about 1 in 57)**.

At **0.85** the same sample clears 62% of the band and interruption falls to
**1.03% of mutating calls (about 1 in 97)**, with the `destructive >= 0.7` and
`credentials` blocks untouched. Raising the other three lines was measured and
rejected: `destructive` 0.5 → 0.9 changed one call, `credentials` 0.6 → 0.7 one,
`blastRadius` 2 → 2.5 none. The 93 newly-cleared calls were screened against the
classes that must never clear — unrecoverable deletion, history rewrite,
credential reads, privilege change, remote effects — and every match was a
tracked file, a regenerable artifact (rendered frames, `terraform.lock.hcl`), a
scratch copy under `/tmp`, or the documented dummy `AKIA…EXAMPLE`.

That screen is a reading of 93 commands, not a proof, which is what the labeled
cases are for: `node scripts/validate-judge.mjs` is unmoved by the change —
**24/24, 0 too strict, 0 too lax, 18/18 dangerous actions caught**.

`node scripts/validate-judge.mjs` runs 24 labeled cases through the **whole**
pipeline against the live judge and exits non-zero on a miss (as of 2026-10).
`--policy` runs the deterministic layer alone: 0 misses, 19/19 dangerous
caught, 4 deferred to the judge.

`node scripts/judge-thresholds.mjs <sample.json>` scores candidate threshold
sets against a saved shadow sample, for free: same judgments, any number of
lines. `--show-allow` lists what each candidate would newly clear.

Those lines were measured on `jev-1.13.0`, recorded as `THRESHOLDS.tunedModel`
next to the numbers in `judge.mjs` (and as `CURRENT.tunedModel` in
`scripts/judge-thresholds.mjs`). Every Jev call also appends a local
`jev-decision` session entry. If TypeSafe reports a different model, pi warns
once per session that the lines may need another replay. The thresholds are
not moved. The entry does not store the command. Guardrail entries can be
scored again without the command text:

```sh
node scripts/replay-corpus.mjs --from-ledger session.jsonl --judge-json sample.json
node scripts/judge-thresholds.mjs sample.json
```

The exported action is `(not recorded)`. Signals are the noul and score values
the ledger kept.

Both scripts are read-only and never execute what they read. Run them after
touching thresholds, question wording, or the shape tables.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_GUARDRAIL` | unset (on) | `off` / `0` / `false` disables the extension for the whole process |
| `PI_GUARDRAIL_TIMEOUT_MS` | `4000` | judge deadline; the failure path is `confirm` with a UI, `block` without one |
| `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, `TYPESAFE_MODEL` | — | shared with `pi-typesafe`; see `shared/systemone.mjs`. The judge uses Pi's classifier when one is registered. A failure is still `confirm` with a UI and `block` without one. |

In-session: `/guardrail` for status and counters, `/guardrail off` and
`/guardrail on` to disarm and re-arm; `/guardrail revoke` clears current grants.

With no interactive UI (`-p`, JSON, or a host without dialogs) the flagged band
is **refused**, never assumed: there is nobody to ask, so the safe answer is no.

## What it does not cover

This is a guardrail, not a sandbox. It reads what the model wrote, not what a
binary or an obfuscated payload does.

- One level of indirection is followed — heredoc bodies are treated as data,
  `sh -c "…"` and `node -e "…"` payloads are classified as shell first and as
  source second, `$(…)` bodies are evaluated as commands, and a referenced
  script is read (bounded to 64KB) and classified. A payload that decodes or
  fetches its real work at runtime is out of scope.
- `readOnlyHint: false` from any tool is inspected, even when the name looks
  read-only. `readOnlyHint: true` is trusted only for tools this repo
  registers (`OWNED_TOOL_NAMES` in `shared/tool-annotations.mjs`). Pi copies
  MCP servers' own hints and does not verify them, so an outside read-only
  claim keeps the previous rule: a command-shaped argument runs the shell
  rules, secret or system paths are refused, and names that look read-only
  (`get_*`, `list_*`, `lore_*`, and pi's own discovery tools) are trusted.
  A namespaced/MCP tool whose read-only hint is absent, or that declares
  `destructiveHint: true`, still requires scoped human authorization.
- **Subagents are covered.** `pi-subagents` builds children with
  `DefaultResourceLoader({ agentDir, extensionFactories: [...] })`, and
  `agentDir` is what makes pi load global extensions — so a child gets this
  guardrail plus its own inline child policy. Child sessions have no UI, so the
  flagged band *blocks* there instead of prompting: an unattended agent gets a
  refusal, a human gets a dialog.
- Catastrophic patterns are matched against source with string literals
  blanked, so a test fixture full of `"rm -rf ~"` strings is not treated as
  though it ran. The consequence is deliberate: `shutil.rmtree('/Users')` in an
  inline payload becomes a judgment and a dialog rather than a refusal.

## Known tradeoffs

- **Ordinary location is not a signal.** Outside protected control files,
  a write outside the session's cwd is allowed —
  the guardrail does not care which repo you are in, only whether the target is
  a secret, a system path, or a dotenv file. The rule that did care produced
  eight prompts in one session, all legitimate config writes in a sibling repo.
- **A script that discusses destructive commands may still be judged.** Quoted
  text is blanked before matching, so a fixture or a comment mentioning
  `rm -rf` is ignored; a file that *defines* those patterns (including this
  guardrail's own source) can still be read as suspicious. The result is a
  silent judgment, never a prompt.
- **`rm src/app.ts` is allowed.** The judge scores it 0.46 destructive with
  blast radius "this working directory, recoverable from version control".
  Disagreeing costs one line (`THRESHOLDS.destructive = 0.45`) and buys a prompt
  on every deliberate cleanup; the case is recorded in `scripts/validate-judge.mjs`
  so the choice stays visible rather than accidental.
- **No durable session allowlist.** Only deterministic authorization/control
  scopes are reused within the current input. Other destructive confirmations
  still ask each time. The historical dialog rate above does not cover these
  new authorization rules.
- **`PATH`-level classifiers are heuristics.** `dist`, `build`, `coverage`,
  `node_modules`, `.cache`, `/tmp` and lock files count as regenerable: deleting
  an irreplaceable file that happens to live in `dist/` would count as cheap.
- **Judge failures fall back to a dialog, not to silence.** A slow or
  unreachable judge delays the tool call by up to the deadline.

## Tests

`node --test packages/guardrail/test/*.test.mjs`:

- `policy.test.mjs` — shapes, target classes, quoting, heredocs, chaining,
  indirection, file tools, unknown tools, annotation hints.
- `judge.test.mjs` — question shape, state, thresholds and their boundaries,
  recommendations, and the failure paths (a `null` from the judge must never
  read as a confident zero).
- `extension.test.mjs` — the whole path with a fake pi and a fake UI: approve,
  deny, suggest, cancelled dialog, no UI, kill switch, script reading, secret
  writes, annotation hints from `getAllTools`.
- `shell-parse.test.mjs` — the shared parser, including the two real bugs its
  callers hit: heredoc bodies parsed as shell, and quote desync inside `$( )`.
