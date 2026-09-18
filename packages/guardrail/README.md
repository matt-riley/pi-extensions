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

## Measured behaviour

`node scripts/replay-corpus.mjs` replays every bash/edit/write call in
`~/.pi/agent/sessions` and reports what the guardrail would have done:

| | 19,470 tool calls (132 sessions) |
| --- | --- |
| allow | 97.66% |
| judge | 1.50% (~1 per 67 mutating calls) |
| confirm | 0.84% (~1 dialog per session) |
| block | 0.01% |

`node scripts/validate-judge.mjs` runs 24 labeled cases through the **whole**
pipeline against the live judge and exits non-zero on a miss: **24/24, 0 too
strict, 0 too lax, 18/18 dangerous actions caught** (as of 2026-09). `--policy`
runs the deterministic layer alone: 0 misses, 19/19 dangerous caught, 4
deferred to the judge.

Both scripts are read-only and never execute what they read. Run them after
touching thresholds, question wording, or the shape tables.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_GUARDRAIL` | unset (on) | `off` / `0` / `false` disables the extension for the whole process |
| `PI_GUARDRAIL_TIMEOUT_MS` | `4000` | judge deadline; the failure path is `confirm` with a UI, `block` without one |
| `TYPESAFE_API_KEY`, `TYPESAFE_BASE_URL`, `TYPESAFE_MODEL` | — | shared with `pi-typesafe`; see `shared/systemone.mjs` |

In-session: `/guardrail` for status and counters, `/guardrail off` and
`/guardrail on` to disarm and re-arm.

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
- Unknown tools from other extensions are judged by their arguments: a
  command-shaped argument runs the shell rules, and secret or system paths are
  refused. Tool names that look read-only (`get_*`, `list_*`, `lore_*`, and pi's
  own discovery tools) are trusted and never inspected.
- Catastrophic patterns are matched against source with string literals
  blanked, so a test fixture full of `"rm -rf ~"` strings is not treated as
  though it ran. The consequence is deliberate: `shutil.rmtree('/Users')` in an
  inline payload becomes a judgment and a dialog rather than a refusal.

## Known tradeoffs

- **`rm src/app.ts` is allowed.** The judge scores it 0.46 destructive with
  blast radius "this working directory, recoverable from version control".
  Disagreeing costs one line (`THRESHOLDS.destructive = 0.45`) and buys a prompt
  on every deliberate cleanup; the case is recorded in `scripts/validate-judge.mjs`
  so the choice stays visible rather than accidental.
- **No session memory.** Approving the same action twice asks twice. The
  measured cost is about one dialog per session, so an allowlist would add
  state and drift for very little; add `Approve for this session` as a fourth
  option if that stops being true.
- **`PATH`-level classifiers are heuristics.** `dist`, `build`, `coverage`,
  `node_modules`, `.cache`, `/tmp` and lock files count as regenerable: deleting
  an irreplaceable file that happens to live in `dist/` would count as cheap.
- **Judge failures fall back to a dialog, not to silence.** A slow or
  unreachable judge delays the tool call by up to the deadline.

## Tests

`node --test packages/guardrail/test/*.test.mjs` — 56 cases:

- `policy.test.mjs` — shapes, target classes, quoting, heredocs, chaining,
  indirection, file tools, unknown tools.
- `judge.test.mjs` — question shape, state, thresholds and their boundaries,
  recommendations, and the failure paths (a `null` from the judge must never
  read as a confident zero).
- `extension.test.mjs` — the whole path with a fake pi and a fake UI: approve,
  deny, suggest, cancelled dialog, no UI, kill switch, script reading, secret
  writes.
- `shell-parse.test.mjs` — the shared parser, including the two real bugs its
  callers hit: heredoc bodies parsed as shell, and quote desync inside `$( )`.
