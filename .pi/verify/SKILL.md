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
uncommitted work. `node .pi/verify/doctor.mjs` prints HEAD and the changed-path
count on every run; `node .pi/verify/workbench.mjs` ends with the HEAD it
tested and `node .pi/verify/jobs.mjs` also prints the working-tree fingerprint.
Any edit after a run
invalidates that run's evidence — rerun from Doctor rather than reusing a line
from an earlier revision.

## Launch

Nothing needs starting by hand and no port needs reserving: every host harness
(smoke, workbench, jobs) starts its own local scripted provider on `127.0.0.1`
port 0 and points pi at a temporary agent directory, so user settings, sessions
and credentials are never read or written.

```sh
npm run check                                  # conventions, tsc, lint, format, knip, fallow, tests
npm run verify                                 # add -- --live for one real TypeSafe request
npm run smoke                                  # real pi RPC host, all 20 manifest extensions
node .pi/verify/workbench.mjs --regular        # real tmux + pi + Neovim, inline UI mode
node .pi/verify/workbench.mjs --upgrade        # prior-HEAD footer upgraded through /reload
node .pi/verify/jobs.mjs                       # real tmux + pi, /jobs logs, PTY takeover, shutdown
bash .pi/verify/jobs-linux.sh                  # GNU script PTY primitives in an offline container
```

Requirements: `pi` 1.4.0 or later on `PATH` (`PI_SMOKE_BIN` overrides the binary
for smoke); `tmux`, `nvim` and `git` for the workbench and jobs drives; `docker`
for `jobs-linux.sh` (it uses an already-cached `buildpack-deps:bookworm-scm` and
never pulls); `gh` authenticated for `watch_pr`. Smoke sets `PI_OFFLINE=1`, a
fixture `TYPESAFE_BASE_URL` and a temporary `PI_CODING_AGENT_DIR`; workbench and
jobs start tmux with `env -i` plus temporary `HOME`, `XDG_CONFIG_HOME`,
`PI_CODING_AGENT_DIR` and session dir.

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
  `-e builtin:codemode` whenever the row needs a deferred tool.
- Deferred tools (`plan_mode_*`, `find_code`, `influencer_*`,
  `diagnosis_checkpoint`, `measure_command`, `blast_radius`, `watch_pr`,
  `terminal_*`) stay out of the default tool list, so the model reaches them
  through codemode's `searchTools` (plan mode activates its own three). Drive
  them from a normally loaded session: with explicit `-e` paths only, a live
  drive here reported them as unavailable to the model.
- Record the request you typed and the raw tool result, not the model's summary
  of it. Quit with `/exit` and delete `$tmp` afterwards. Each model turn is a
  real, billable request — batch several tool calls into one prompt.

## Doctor

```sh
node .pi/verify/doctor.mjs
```

It checks `pi` (must be >= 1.4.0), `tmux`, `nvim` and `git`, reports whether
`gh`, `docker` and `TYPESAFE_API_KEY` are available, and prints the target
revision. Exit 0 means the offline gates and the terminal harnesses can run;
exit 1 names each missing tool. It starts nothing, so run it before the first
drive and again after anything surprising (a dead tmux server, a vanished `pi`,
an auth error).

## Features

Offline coverage — run every row on every change:

| Feature | Drive | Observe |
| --- | --- | --- |
| All 20 extensions load; `/plan`, `/subagents`, `/route`, `/guardrail`, `/safe-compact`, `/jobs`, `/ui`, `/footer` register | `npm run smoke` | `ok: real host loads 20 manifest extensions` |
| Owned skills and `/review`, `/pr`, `/test`, `/refactor`, `/design` prompts expand outside the repo | `npm run smoke` | `ok: owned skills and workflow prompts discover and expand outside the repo` |
| Background jobs: real completion follow-up, real failure status, optional Jev watch on redacted evidence | `npm run smoke` | both `ok: real background …` / `ok: background tools …` lines |
| TypeSafe `find_code` and injection warnings through nested codemode | `npm run smoke` | the two `ok: … semantic/MCP …` lines |
| `measure_command` trials and empty-work refusal | `npm run smoke` | `ok: controlled measurement executes nested trials and rejects empty work` |
| Failed-fix checkpoint (diagnosis-nudge) blocks native, shell and nested mutations until an observation | `npm run smoke` | `ok: two failed fixes block native, shell and nested mutations until a real checkpoint` |
| Plan mode: read-only denial, the three plan tools offered, gone after `/plan exit` | `npm run smoke` | the three `ok: plan …` lines |
| Subagents: `/subagents on`, real child, `verified`/`failed`/`unknown` outcome reporting | `npm run smoke` | the three `ok: … child …` lines |
| Done-gate: one quiet nudge after an unverified edit, none for an outside-cwd write | `npm run smoke` | both `ok: done-gate …` lines |
| `/until <cmd>` sends the agent back until the predicate exits 0 | `npm run smoke` | `ok: /until sends the agent back until the predicate exits 0` |
| Workbench: command groups, intent search, cancel, built-in preparation, draft recovery, `/files` reference, `/changes` previews, Neovim handoff, `/eixt` → `/exit` suggestion, resize, working→ready | `node .pi/verify/workbench.mjs --regular` | the five `ok:` lines plus `Local real-TUI acceptance passed at HEAD …` |
| Footer: actual work state, and a prior-HEAD footer upgrading through `/reload` | `node .pi/verify/workbench.mjs --upgrade` | `ok: prior HEAD footer upgrades through actual /reload` plus the lifecycle line |
| `/jobs` live logs, follow/scroll/resize/cancel, same-PTY input, detach/reattach, Ctrl+C, human line input, `/exit` and `/reload` stopping owned processes | `node .pi/verify/jobs.mjs` | the five `ok:` lines plus `Local real-TUI jobs acceptance passed at HEAD …` |
| GNU `script` PTY: native input, dimensions, group identity, exit status with input still open | `bash .pi/verify/jobs-linux.sh` | `ok: GNU PTY input, dimensions, group identity and exit 9 with input still open` |
| Every manifest entry registers; owned skills rank | `npm run verify` | `24/24 checks passed` |
| Live TypeSafe transport | `npm run verify -- --live` | `ok    live TypeSafe call — jev-…` and `25/25 checks passed` |

Model-, network- or device-dependent coverage — drive the affected row when the
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
| `batch_web_fetch`, `web_search` | live session: a batch of two URLs, then a query | each request's result; ranked results with URLs | network, provider | **unproven** |
| `lint_change`, `verify_findings` | live session: lint the staged diff, then verify its findings | findings whose quotation is absent from the diff are dropped | `TYPESAFE_API_KEY` | **unproven** |
| Guardrail: catastrophic refusal, deterministic rules, Approve/Deny/Suggest dialog | live TUI: ask for a destructive command against a scratch target | refusal with no dialog for the catastrophic set; a decision dialog otherwise | real TTY + provider | **unproven** |
| Router `router/auto` | live TUI: `/model` → `router/auto`, send a hard task | one escalation at task start, back to base next task | provider credentials with a frontier model | **unproven** |
| `/improve` prompt coach | live TUI: `/improve fix the failing test` | a verified rewrite submitted as the next user message | Docker Model Runner with Gemma4 at `127.0.0.1:12434` + `TYPESAFE_API_KEY` | **unproven** |
| `/influencer` deferred tools and briefs | live TUI: `/influencer`, then build a character brief | tools activate; a brief is produced and saved | a provider | **unproven** |
| `self_compact`, `/safe-compact-info`, `/safe-compact-plan` | live TUI, in a throwaway session | thresholds and the plan for the current context; handoff note survives compaction | automatic threshold needs a long context; `self_compact` compacts the session that calls it, so never drive it in the session holding the evidence | **unproven** |
| `/diagnosis` (status and `/diagnosis reset`) | live TUI after a blocked fix | the block reason, or `Diagnosis checkpoint: no pending gate.` | real TTY | **unproven** |
| `/footer details` | live TUI: `/footer details` | model accounting and extension statuses | real TTY | **unproven** |
| Review lint, findings verification and plan review reach the real judge | `node scripts/judges-live.mjs` (or `--only review`) | `all N judgments reached their judge` | `TYPESAFE_API_KEY`; one real request per case | proven |
| Classifiers `/triage --ci`, `/mine`, `/retro` | `node scripts/ci-triage.mjs --log <file> --step "<step>" --reruns N` (and siblings) | a class with confidence, or an explicit "could not judge" | a CI log for `--ci`; `TYPESAFE_API_KEY` for the judgment | **unproven** |

Deferred tools need codemode: ask the model for the behaviour, then check that
`searchTools` found the tool and the raw call returned. A missing tool, an
unexpected rejection or an empty result is a finding — write it down instead of
rewording the prompt until something appears.

## Last proven run

2026-10-25, target `c03e9ad` plus the four `.pi/verify/` edits below (this
recipe, `doctor.mjs`, `jobs.mjs`, and the exec bit on both scripts), Node 26.12.1,
pi 1.4.0, tmux 3.8, Neovim 0.13.0, gh authenticated, Docker ready.

```text
$ node .pi/verify/doctor.mjs
ok      pi    1.4.0
ok      tmux  3.8
ok      nvim  0.13.0
ok      git   2.56.0
ok      gh ready
ok      docker ready
target  c03e9ad, 4 changed path(s) in the working tree
ok      TYPESAFE_API_KEY set — live judgment and web_answer drives are available
doctor: ready for npm run check, npm run verify, npm run smoke and the workbench drive
```

`npm run check` used to be intermittently red here (9 of 18 full-suite runs):
the teardown of `packages/done-gate/test/extension.test.mjs:89` failed with
`Error: kill EPERM` from `Jobs.#kill`, because `shutdown` (`jobs.mjs:342`)
awaits `Promise.all` over `stop` and `#kill` rethrew everything except
`ESRCH`. Measured cause: the job's group leader had exited but not been reaped,
and macOS refuses to signal a zombie group with `EPERM`. `#kill` now treats
`EPERM` like `ESRCH` — the process is gone, and the close-time SIGKILL sweep
still reaps surviving descendants. Verified at the fix by instrumenting
`process.kill`: the window still hit 3 of 18 parallel `done-gate` runs with 0
test failures, and 3 consecutive `npm run check` runs passed (1301 tests).

```text
$ npm run verify
24/24 checks passed

$ npm run verify -- --live
ok    live TypeSafe call — jev-1.13.0 (input_tokens=295 output_tokens=20)
25/25 checks passed

$ npm run smoke
ok: real host loads 20 manifest extensions
ok: owned skills and workflow prompts discover and expand outside the repo
ok: real background completion resumes the agent once with a follow-up, not steering
ok: background tools preserve real failure status; optional Jev watches use redacted fixture evidence
ok: nested semantic search works and URL credentials never reach the fixture judge
ok: structured MCP-shaped nested result keeps its schema and warns the model through codemode
ok: controlled measurement executes nested trials and rejects empty work
ok: two failed fixes block native, shell and nested mutations until a real checkpoint
ok: plan mode blocks harmless fixture write through real tool dispatch
ok: plan mode offers plan_mode_question, plan_mode_complete, and plan_fetch_url
ok: plan tools are gone after /plan exit
ok: leave plan mode, explicitly enable subagents, complete child with unknown task outcome
ok: actual child command evidence reports verified separately from execution completion
ok: actual child command evidence reports failed separately from execution completion
ok: done-gate continues once after an unverified edit
ok: done-gate ignores edits outside the session cwd
ok: /until sends the agent back until the predicate exits 0
Offline host smoke passed; model reasoning, UI and external providers were not tested.

$ node .pi/verify/workbench.mjs --regular
ok: live command intent filtering, cancellation, built-in preparation and draft recovery
ok: native file picker preserves draft and inserts a reference, not contents
ok: non-editable staged/unstaged diffs, next/previous files, retained query/selection/scroll and Neovim return; no file/index/model changes
ok: /eixt restored with /exit suggestion; no execution or model request; valid commands still dispatch
ok: narrow resize, Unicode file reference, actual working → ready lifecycle (regular)
Local real-TUI acceptance passed at HEAD c03e9ad plus working tree.

$ node .pi/verify/workbench.mjs --upgrade
ok: prior HEAD footer upgrades through actual /reload
… (same workbench lines, fullscreen lifecycle)
Local real-TUI acceptance passed at HEAD c03e9ad plus working tree.

$ node .pi/verify/jobs.mjs
ok: real Pi live logs follow, scroll, resize and cancel without model calls
ok: same PTY accepts native input, resize, detach/reattach and preserves exit 7
ok: Ctrl+C reaches the foreground PTY program and returns to a live Pi
ok: explicit human line input reaches the owned pipe job
ok: reload, session changes and shutdown stop owned processes without model calls
Local real-TUI jobs acceptance passed at HEAD c03e9ad plus working tree <fingerprint>.
# <fingerprint> is the working-tree hash from `revisionSnapshot`; editing this
# file changes it, so compare the run's line against the tree you tested.

$ bash .pi/verify/jobs-linux.sh
native
25 90
got:native
script exit status: 9; PTY identity: /dev/pts/0 14
ok: GNU PTY input, dimensions, group identity and exit 9 with input still open

$ node scripts/judges-live.mjs --only review
ok   review lint — scope_creep 0.86
ok   review findings — 1 kept, 1 dropped (quoted text is not in the diff)
ok   plan review — 2 step(s) without verification, 0 without callers
all 3 judgments reached their judge
```

Live rows proven in the same run, from an isolated `--api-key` session and from a
normally loaded one: `repo_map` (`375 files · 8016 symbols`), `code_search`
(`# code_search "revisionSnapshot" — 27 matches`, definition first),
`file_outline` (symbols with line ranges), `find_definition`
(`shared/revision.mjs:11 function revisionSnapshot (exported)`), `skill_select`
(`implementation-review (p 1.00)`), `web_fetch` (`title: Example Domain`),
`web_answer` (`[passage 1 · 0.97]`), `blast_radius` (callers outside the diff and
`no test mentions it` symbols), `watch_pr` (`closed`, `PR #45 head 695f004a`),
`view_context` (`percent 7.53`).

Two findings from that run, reported rather than smoothed over: `code_search`
rejects `path: "."` with `Rejected: path resolves to empty`
(`packages/code-search/index.ts:209`, because `normalizeRel(".")` is empty), and
the `npm run check` failure above.

## Cleanup

The harnesses clean up in `finally`: smoke closes the pi process, fixture server
and temporary directory; workbench and jobs kill their tmux server, stop owned
processes and remove their fixture; `jobs-linux.sh` removes its container on
`EXIT`. None touches `~/.pi/agent`. A failure during setup, before the `try`
block, skips that cleanup. After a forced kill or a crash, finish it by hand:

```sh
tmux ls                                                  # no pi-workbench-<pid> / pi-jobs-<pid> server
pgrep -fl 'pi-workbench-ui-|pi-jobs-ui-|pi-smoke-'       # no orphaned pi, tmux or nvim
tmux -L pi-workbench-<pid> kill-server                   # only for a leftover socket
docker ps -a --filter name=pi-jobs-linux                 # no leftover container
find "${TMPDIR:-/tmp}" -maxdepth 1 \( -name 'pi-smoke-*' -o -name 'pi-workbench-*' -o -name 'pi-jobs-ui-*' \)
rm -rf "${TMPDIR:-/tmp}"/pi-workbench-ui-* "${TMPDIR:-/tmp}"/pi-jobs-ui-* "${TMPDIR:-/tmp}"/pi-smoke-*
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
what CI will run — CI only runs `npm run check`; no hosted runner executes
`npm run smoke`, the workbench, jobs or `jobs-linux.sh`.
