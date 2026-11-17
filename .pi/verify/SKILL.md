---
name: verify
description: Prove a change to this pi extension collection in the real host — run the offline gates and harnesses, drive each affected feature in real pi, and clean up. Use before reporting done on any extension, tool, command, prompt, skill or TUI change.
---

# Verifying pi-extensions in the real host

`npm run check` proves tests, types, lint and conventions. It does not prove pi
loads the extension, offers the tool, blocks the command or draws the screen.
This recipe is the run that does. [`docs/verification.md`](../../docs/verification.md)
explains what each harness covers and where its evidence stops; this file is the
order to run it in.

## Target

Record the revision before the first drive, because every observation below
belongs to it:

```sh
git rev-parse HEAD
git status --porcelain=v1                              # dirty paths, ?? for untracked
git diff HEAD | git hash-object --stdin                # tracked content fingerprint
git ls-files -z --others --exclude-standard | xargs -0 -r cat | git hash-object --stdin
```

HEAD alone does not identify a dirty tree, and a commit hash does not identify
uncommitted work. The harnesses print HEAD (jobs also the tree fingerprint) with
their result. Any edit after a run invalidates that run's evidence, so rerun from
Doctor rather than reusing a line from an earlier revision.

## Launch

Nothing needs starting by hand and no port needs reserving: every host harness
(smoke, workbench, jobs) starts its own local scripted provider on `127.0.0.1`
port 0 and points pi at a temporary agent directory, so user settings, sessions
and credentials are never read or written.

```sh
npm run check                                  # conventions, tsc, lint, format, knip, fallow, tests
npm run verify                                 # add -- --live for one real TypeSafe request
npm run smoke                                  # real pi RPC host, all manifest extensions
node .pi/verify/workbench.mjs --regular        # real tmux + pi + Neovim, inline UI mode
node .pi/verify/workbench.mjs --upgrade        # prior-HEAD footer upgraded through /reload
node .pi/verify/jobs.mjs                       # real tmux + pi, /jobs logs, PTY takeover, shutdown
bash .pi/verify/jobs-linux.sh                  # GNU script PTY primitives in an offline container
node .pi/verify/toasts.mjs                     # real TUI: extension notify becomes a toast, then clears
```

Requirements: `pi` 1.4.0 or later on `PATH` (`PI_SMOKE_BIN` overrides the binary
for smoke); `tmux`, `nvim` and `git` for the workbench and jobs drives; `docker`
for `jobs-linux.sh` (it uses an already-cached `buildpack-deps:bookworm-scm` and
never pulls); `gh` authenticated for `watch_pr`. The toasts drive needs only
`pi` and `tmux`.

For a live per-change drive (a real provider, disposable config):

```sh
root=$(git rev-parse --show-toplevel)
tmp=$(mktemp -d); mkdir -p "$tmp/agent" "$tmp/workspace"; cd "$tmp/workspace"
PI_CODING_AGENT_DIR="$tmp/agent" PI_CODING_AGENT_SESSION_DIR="$tmp/sessions" \
  pi --no-extensions --no-mcp --no-context-files --no-skills --no-prompt-templates \
     --no-approve --no-session \
     --provider <provider> --model <model> \
     --api-key "$(pi auth print-bearer-token --provider <provider>)" \
     -e "$root/packages/<name>/index.ts" -e builtin:codemode
```

- Load only the extension under test with `-e`. The credential is printed from
  pi's own store into `--api-key`; never copy `~/.pi/agent` into the fixture.
- `--no-extensions` stops discovery *and* drops builtin codemode, so name
  `-e builtin:codemode` whenever the row needs a deferred tool. `-e` alone loads
  the extension but leaves the **tool** inactive (built-ins register inactive),
  so the model still sees only `read`/`bash` and the extension's declared tools.
  Add `--tools +codemode` (or `"defaultTools": ["+codemode"]` in the fixture
  settings). Without it, every deferred-tool row silently drives nothing.
- Deferred tools (`plan_mode_*`, `find_code`,
  `diagnosis_checkpoint`, `measure_command`, `blast_radius`, `watch_pr`, `decision_log`, `review_panel`, `swarm_report`, `rerun_findings`, `terminal_*`) stay out of the default tool list, so the model reaches them
  through codemode's `searchTools` (plan mode activates its own three). Drive
  them from a normally loaded session: with explicit `-e` paths only, a live
  drive here reported them as unavailable to the model.
- Record the request you typed and the raw tool result, not the model's summary
  of it. Quit with `/exit` and delete `$tmp` afterwards. Each model turn is a
  real, billable request, so batch several tool calls into one prompt.

## Doctor

```sh
node .pi/verify/doctor.mjs
```

Exit 0 means the offline gates and the terminal harnesses can run; exit 1 names
each missing tool. It starts nothing, so run it before the first drive and again
after anything surprising (a dead tmux server, a vanished `pi`, an auth error).

## Features

Offline coverage (run every row on every change):

| Feature | Drive | Observe |
| --- | --- | --- |
| All manifest extensions load; `/plan`, `/subagents`, `/route`, `/guardrail`, `/safe-compact`, `/jobs`, `/ui`, `/footer` register | `npm run smoke` | `ok: real host loads … manifest extensions` |
| Owned skills and `/review`, `/pr`, `/test`, `/refactor`, `/design`, `/interrogate` prompts expand outside the repo | `npm run smoke` | `ok: owned skills and workflow prompts discover and expand outside the repo` |
| `watch_pr`: clean readiness, incomplete/mixed-head refusal and later-page threads, with isolated `gh` fixtures | `npm run smoke` | `ok: watch_pr rejects incomplete or mixed-head evidence and finds later-page threads` |
| Background jobs: real completion follow-up, real failure status, optional Jev watch on redacted evidence | `npm run smoke` | both `ok: real background …` / `ok: background tools …` lines |
| TypeSafe `find_code` and injection warnings through nested codemode | `npm run smoke` | the two `ok: … semantic/MCP …` lines |
| `measure_command` trials and empty-work refusal | `npm run smoke` | `ok: controlled measurement executes nested trials and rejects empty work` |
| `decision_log` appends a trail row and reports evidence that does not resolve | `npm run smoke` | `ok: decision_log appends a trail row and reports evidence that does not resolve` |
| `rerun_findings` keeps a still-failing command, drops one that exits 0, through nested bash | `npm run smoke` | `ok: rerun_findings reruns finding commands through nested bash and keeps failures` |
| Failed-fix checkpoint (diagnosis-nudge) blocks native, shell and nested mutations until an observation | `npm run smoke` | `ok: two failed fixes block native, shell and nested mutations until a real checkpoint` |
| Plan mode: read-only denial, the three plan tools offered, gone after `/plan exit` | `npm run smoke` | the three `ok: plan …` lines |
| Subagents: `/subagents on`, real child, `verified`/`failed`/`unknown` outcome reporting | `npm run smoke` | the three `ok: … child …` lines |
| Subagents: an isolated writer in its own worktree, with the parent's dirty state copied in | `npm run smoke` | `ok: an isolated writer works in its own worktree with the parent's dirty state` |
| Done-gate: one quiet nudge after an unverified edit, none for an outside-cwd write | `npm run smoke` | both `ok: done-gate …` lines |
| `/until <cmd>` sends the agent back until the predicate exits 0 | `npm run smoke` | `ok: /until sends the agent back until the predicate exits 0` |
| `/climb` measures the baseline first, refuses a red gate, stops on a met target (the attempt loop is covered only by `node --test packages/until`) | `npm run smoke` | `ok: /climb measures the baseline first and refuses a red gate in a live Pi` |
| Extension `ctx.ui.notify` becomes a self-clearing top-right toast; `PI_TOAST_CAPTURE=0` leaves pi's own row; narrow terminals hide it | `node .pi/verify/toasts.mjs` | the three `ok:` lines plus `Local real-TUI toasts acceptance passed at HEAD …` |
| Workbench: command groups, intent search, cancel, built-in preparation, draft recovery, `/files` reference, `/changes` previews, Neovim handoff, `/eixt` -> `/exit` suggestion, resize, working->ready | `node .pi/verify/workbench.mjs --regular` | the five `ok:` lines plus `Local real-TUI acceptance passed at HEAD …` |
| Footer: actual work state, and a prior-HEAD footer upgrading through `/reload` | `node .pi/verify/workbench.mjs --upgrade` | `ok: prior HEAD footer upgrades through actual /reload` plus the lifecycle line |
| `/jobs` live logs, follow/scroll/resize/cancel, same-PTY input, detach/reattach, Ctrl+C, human line input, `/exit` and `/reload` stopping owned processes | `node .pi/verify/jobs.mjs` | the five `ok:` lines plus `Local real-TUI jobs acceptance passed at HEAD …` |
| GNU `script` PTY: native input, dimensions, group identity, exit status with input still open | `bash .pi/verify/jobs-linux.sh` | `ok: GNU PTY input, dimensions, group identity and exit 9 with input still open` |
| Every manifest entry registers; owned skills rank | `npm run verify` | a `checks passed` line and no `fail`; the count varies with the installed skill library (26/26 on 2026-10-29) |
| Live TypeSafe transport | `npm run verify -- --live` | `ok    live TypeSafe call — jev-…` and a `checks passed` line |

Model-, network- or device-dependent coverage: drive the affected row when the
change touches it. `proven` means driven at the revision in **Last proven run**;
`unproven` means it was not, and the reason is the prerequisite.

| Feature | Drive | Observe | Prerequisite | Status |
| --- | --- | --- | --- | --- |
| `repo_map`, `code_search`, `file_outline`, `find_definition` | live session: ask for each once | ranked hits with enclosing function, outline, definition first | a provider | proven |
| `web_fetch`, `web_answer` | live session: `web_fetch https://example.com`, then `web_answer` on the same URL | `title: Example Domain` plus body; only quoted passages | network, provider (+ `TYPESAFE_API_KEY` for `web_answer`) | proven |
| `skill_select` from outside this repo | live session: ask for a skill that reviews a staged diff | `implementation-review` with its `SKILL.md` path | a provider | proven |
| `blast_radius` | codemode: `searchTools("blast radius")`, then `tools.blast_radius({scope:"range", ref:"HEAD~3"})` | caller files outside the diff, symbols no test mentions | a provider, a repo with history | proven |
| `watch_pr` | codemode: `searchTools("pull request checks")`, then `tools.watch_pr({pr:"45"})` | verdict, PR number, head SHA, state | `gh` authenticated | proven |
| `view_context` | live session: ask for it | `{"tokens":…,"contextWindow":…,"percent":…}` | a provider | proven |
| `batch_web_fetch`, `web_search` | codemode: `searchTools("batch web fetch")`, then `tools.batch_web_fetch({requests:[{url},{url}]})`; then `tools.web_search({query})` | `2 URLs — 2 ok, 0 failed`; ranked results with URLs | network, provider, `--tools +codemode` | proven |
| `lint_change`, `verify_findings` | live session in a repo with a staged diff: lint it, then verify the findings | findings whose quotation is absent from the diff are dropped | `TYPESAFE_API_KEY` + a staged diff | **unproven** (no staged diff was driven this pass) |
| Guardrail dialog | live TUI: `git push --force origin main` against a scratch repo | `✅ Approve / ⛔ Deny / ✏️ Suggest an alternative`; Deny leaves the remote untouched and the model reports the refusal | real TTY + provider | proven |
| Guardrail deterministic and catastrophic refusal | live TUI: `rm -rf .git` in a scratch repo | `The guardrail refused this call (rm would destroy credentials or VCS internals)`, no dialog | real TTY | proven |
| Router `router/auto` | live TUI: `/model` -> `router/auto`, send a hard task | one escalation at task start, back to base next task | provider credentials with a frontier model | **unproven** (not driven this pass) |
| `/improve` prompt coach | live TUI: `/improve fix the failing test` | a verified rewrite placed in the input box (not sent) | `OPENAI_API_KEY` or `DEEPSEEK_API_KEY` + `TYPESAFE_API_KEY` (Matt sets these up; not driven since the move to a hosted model) | **unproven** (not driven this pass) |
| `/plan check` comprehension | live TUI: `/plan`, then `/plan check` with `.pi/PLAN.md` present | `## Plan comprehension check` appended with the reader's restatement and Gaps, or `not run` with the reason | provider for the reader child + `TYPESAFE_API_KEY` for Jev | **unproven**: a scripted tmux drive left the TUI blank and never appended, and no working harness exists yet |
| `self_compact`, `/safe-compact-info`, `/safe-compact-plan` | live TUI, in a throwaway session | thresholds and the plan for the current context; handoff note survives compaction | automatic threshold needs a long context; `self_compact` compacts the session that calls it, so never drive it in the session holding the evidence | **unproven** |
| `/diagnosis` (status and `/diagnosis reset`) | live TUI after a blocked fix | the block reason, or `Diagnosis checkpoint: no pending gate.` | real TTY | proven (`no pending gate` with no pending block) |
| `/footer details` | live TUI: `/footer details` | `Usage: ↑… ↓… $…` then `/session for native session details.` | real TTY | proven |
| Review lint, findings verification and plan review reach the real judge | `node scripts/judges-live.mjs` (or `--only review`) | `all N judgments reached their judge` | `TYPESAFE_API_KEY`; one real request per case | proven |
| Classifiers `/triage --ci`, `/mine`, `/retro` | `node scripts/ci-triage.mjs --log <file> --step "<step>" --reruns N` (and siblings) | a class with confidence, or an explicit "could not judge" | a CI log for `--ci`; `TYPESAFE_API_KEY` for the judgment | **unproven** |

Deferred tools need codemode: ask the model for the behaviour, then check that
`searchTools` found the tool and the raw call returned. A missing tool, an
unexpected rejection or an empty result is a finding. Write it down instead of
rewording the prompt until something appears.

## Last proven run

2026-10-29, target `dfbbda1` plus these `.pi/verify/` edits (this recipe and the
new `toasts.mjs` harness), Node 26.12.1, pi 1.4.0, tmux 3.8, Neovim 0.13.0, gh
authenticated, Docker ready. Every offline row was
re-run at this revision; live rows were driven in isolated sessions with
`--api-key "$(pi auth print-bearer-token --provider github-copilot)"`, so the
model turns were real and billable.

Findings from this run still worth knowing (the others are covered in Launch and the table above):

- `rm -rf ./scratch` in a scratch workspace ran with **no** dialog: a regenerable
  target below the cwd is allowed by design. The dialog row needs a call the rules
  escalate (`git push --force`), not merely a destructive-looking one.
- From the 2026-10-25 run and still open: `code_search` rejects `path: "."` with
  `Rejected: path resolves to empty` (`packages/code-search/index.ts:209`, because
  `normalizeRel(".")` is empty).

## Cleanup

Each harness cleans up in `finally` (`jobs-linux.sh` on `EXIT`), and none touches
`~/.pi/agent`. A failure during setup, before the `try` block, skips that cleanup, and a drive killed from outside leaves a live pi
inside a live tmux server, because the `finally` never ran. Finish it by hand:

```sh
tmux ls                                                  # no pi-workbench-<pid> / pi-jobs-<pid> / pi-toasts-<pid> server
pgrep -fl 'pi-workbench-ui-|pi-jobs-ui-|pi-toasts-ui-|pi-smoke-'   # no orphaned pi, tmux or nvim
tmux -L pi-workbench-<pid> kill-server                   # only for a leftover socket
pkill -f 'pi-toasts-ui-<pid>'                            # the pi process outlives its fixture otherwise
docker ps -a --filter name=pi-jobs-linux                 # no leftover container
find "${TMPDIR:-/tmp}" -maxdepth 1 \( -name 'pi-smoke-*' -o -name 'pi-workbench-*' -o -name 'pi-jobs-ui-*' -o -name 'pi-toasts-ui-*' \)
rm -rf "${TMPDIR:-/tmp}"/pi-workbench-ui-* "${TMPDIR:-/tmp}"/pi-jobs-ui-* "${TMPDIR:-/tmp}"/pi-smoke-* "${TMPDIR:-/tmp}"/pi-toasts-ui-*
```

Stop the processes before removing the directories: a surviving Neovim writes
its `~/.local/state` back into a fixture that was already deleted. A successful
run can leave its tmux server visible for a second after it exits; check again
before calling it a leak.

Keep the evidence, not the fixtures: redirect each run to
`"${TMPDIR:-/tmp}/pi-verify-$(git rev-parse --short HEAD).log"` and paste the
lines that prove each feature into the report. Fixtures live outside the repo, so
`git status --porcelain` must still match the Target snapshot when the run is
clean; if it does not, something edited the tree and the evidence is invalid.

Report per feature: the command, the observed line, and any row you could not
drive plus the prerequisite that blocked it. Say separately what ran locally and
what CI will run. CI only runs `npm run check`; no hosted runner executes
`npm run smoke`, the workbench, jobs or `jobs-linux.sh`.
