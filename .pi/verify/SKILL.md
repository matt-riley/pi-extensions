---
name: verify
description: Prove a change to this pi extension collection in the real host — launch the offline gates and harnesses, drive each affected feature in real pi, and clean up. Use before reporting done on any extension, tool, command, prompt, skill or TUI change.
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
tested. Any edit after a run invalidates that run's evidence — rerun from Doctor
rather than reusing a line from an earlier revision.

## Launch

Nothing needs starting by hand and no port needs reserving: the two host
harnesses (smoke and workbench) start their own local scripted provider on
`127.0.0.1` port 0 and point pi at a temporary agent directory, so user settings,
sessions and credentials are never read or written.

```sh
npm run check                                  # conventions, tsc, lint, format, knip, fallow, tests
npm run verify                                 # add -- --live for one real TypeSafe request
npm run smoke                                  # real pi RPC host, all 18 manifest extensions
node .pi/verify/workbench.mjs --regular        # real tmux + pi + Neovim, inline UI mode
node .pi/verify/workbench.mjs --upgrade        # prior-HEAD footer upgraded through /reload
```

Requirements: `pi` 1.4.0 or later on `PATH` (`PI_SMOKE_BIN` overrides the
binary for smoke); `tmux`, `nvim` and `git` for the workbench drive. The smoke
sets `PI_OFFLINE=1`, a fixture `TYPESAFE_BASE_URL` and a temporary
`PI_CODING_AGENT_DIR`; the workbench starts tmux with `env -i` plus temporary
`HOME`, `XDG_CONFIG_HOME`, `PI_CODING_AGENT_DIR` and session dir.

For a live per-change drive (a real provider, disposable config):

```sh
root=$(git rev-parse --show-toplevel)
tmp=$(mktemp -d)
mkdir -p "$tmp/agent" "$tmp/workspace"
cd "$tmp/workspace"
PI_CODING_AGENT_DIR="$tmp/agent" PI_CODING_AGENT_SESSION_DIR="$tmp/sessions" \
  pi --no-mcp --no-context-files -e "$root/packages/<name>/index.ts"
```

Load only the extension under test with `-e`. The provider credential comes from
its inherited environment variable; do not copy `~/.pi/agent`. Quit with
`/exit` and delete `$tmp` afterwards. Record the request you typed and the raw
tool result, not the model's summary of it.

## Doctor

```sh
node .pi/verify/doctor.mjs
```

It checks `pi` (must be >= 1.4.0), `tmux`, `nvim` and `git`, prints the target
revision, and says whether `TYPESAFE_API_KEY` is visible. Exit 0 means the
offline gates and the terminal harness can run; exit 1 names each missing tool.
It starts nothing, so run it before the first drive and again after anything
surprising (a dead tmux server, a vanished `pi`, an auth error).

## Features

Offline coverage — run every row on every change:

| Feature | Drive | Observe |
| --- | --- | --- |
| All 18 extensions load; `/plan`, `/subagents`, `/route`, `/guardrail`, `/safe-compact` register | `npm run smoke` | `ok: real host loads 18 manifest extensions` |
| Owned skills and `/review`, `/pr`, `/test`, `/refactor`, `/design` prompts expand outside the repo | `npm run smoke` | `ok: owned skills and workflow prompts discover and expand outside the repo` |
| Plan mode: read-only denial, the three plan tools offered, gone after `/plan exit` | `npm run smoke` | the three `ok: plan mode …` lines |
| Subagents: `/subagents on`, real child, `verified`/`failed`/`unknown` outcome reporting | `npm run smoke` | the three `ok: … child …` lines |
| Done-gate: one quiet nudge after an unverified edit, none for an outside-cwd write | `npm run smoke` | both `ok: done-gate …` lines |
| `measure_command` trials and empty-work refusal | `npm run smoke` | `ok: controlled measurement executes nested trials and rejects empty work` |
| Failed-fix checkpoint blocks native, shell and nested mutations until an observation | `npm run smoke` | `ok: two failed fixes block native, shell and nested mutations until a real checkpoint` |
| `/until <cmd>` sends the agent back until the predicate exits 0 | `npm run smoke` | `ok: /until sends the agent back until the predicate exits 0` |
| TypeSafe `find_code` and injection warnings through nested codemode | `npm run smoke` | the two `ok: … semantic/MCP …` lines |
| Workbench: command groups, intent search, cancel, built-in preparation, draft recovery, `/files` reference, `/changes` previews, Neovim handoff, `/eixt` → `/exit` suggestion, resize, working→ready | `node .pi/verify/workbench.mjs --regular` | the five `ok:` lines plus `Local real-TUI acceptance passed at HEAD …` |
| Footer: actual work state, and a prior-HEAD footer upgrading through `/reload` | `node .pi/verify/workbench.mjs --upgrade` | `ok: prior HEAD footer upgrades through actual /reload` plus the lifecycle line |
| Every manifest entry registers; owned skills rank | `npm run verify` | `23/23 checks passed` |
| Live TypeSafe transport | `npm run verify -- --live` | `ok    live TypeSafe call — jev-…` and `24/24 checks passed` |
| Review lint, findings verification and plan review reach the real judge | `node scripts/judges-live.mjs` (or `--only review`) | `all N judgments reached their judge`; costs real requests |

Model-, network- or provider-dependent coverage — drive the affected row when
the change touches it. Rows marked **unproven** were not driven in the last run
below; the reason is the prerequisite.

| Feature | Drive | Observe | Prerequisite |
| --- | --- | --- | --- |
| `/exit` graceful shutdown | live TUI: type `/exit` | pi exits and emits `session_shutdown` | real TTY (workbench proves only the `/eixt` suggestion, not shutdown). **unproven** |
| `web_fetch`, `batch_web_fetch`, `web_search` | live TUI: ask for `web_fetch https://example.com` | markdown body and page metadata; a batch returns each request's result | network. **unproven** |
| `web_answer` | live TUI: ask a narrow question about a URL | only quoted passages, no invented summary | network + `TYPESAFE_API_KEY`. **unproven** |
| `repo_map`, `code_search`, `file_outline`, `find_definition` | live TUI: ask for `repo_map` on a repo with ignored files, then a symbol query | tree omits ignored paths; definition ranks above mentions | a provider. The workbench `/files` picker only proves the shared inventory. **unproven** |
| `skill_select` tool from outside this repo | live TUI: ask for a skill that reviews a staged diff | `implementation-review` with its `SKILL.md` path | a provider. `npm run verify` proves the ranker, not the tool. **unproven** |
| Guardrail: catastrophic refusal, rules, Approve/Deny/Suggest dialog | live TUI: ask for a destructive command against a scratch target | refusal with no dialog for the catastrophic set; a decision dialog otherwise | real TTY. **unproven** |
| Router `router/auto` | live TUI: `/model` → `router/auto`, send a hard task | one escalation at task start, back to base next task | provider credentials with a frontier model. **unproven** |
| `/improve` prompt coach | live TUI: `/improve fix the failing test` | a verified rewrite submitted as the next user message | Docker Model Runner with Gemma4 at `127.0.0.1:12434` + `TYPESAFE_API_KEY`. **unproven** |
| `/influencer` deferred tools and briefs | live TUI: `/influencer`, then build a character brief | tools activate; a brief is produced and saved | a provider. **unproven** |
| Safe compaction | live TUI: `/safe-compact-info`, then `/safe-compact-plan` | thresholds and the plan for the current context | automatic threshold needs a long context. **unproven** |
| `lint_change`, `verify_findings` | live TUI: ask to lint the staged diff, then verify its findings | findings whose quotations are absent from the diff are dropped | `TYPESAFE_API_KEY`. **unproven** |
| Classifiers `/triage --ci`, `/mine`, `/retro` | `node scripts/ci-triage.mjs --log <file> --step "<step>" --reruns N` (and siblings) | a class with confidence, or an explicit "could not judge" | a CI log for `--ci`; `TYPESAFE_API_KEY` for the judgment. **unproven** |

## Last proven run

2026-10-24, target `0df52ca` plus 21 changed paths (the in-progress workbench
work, this recipe, and two test files edited while the proof ran), Node 26.12.1,
pi 1.4.0, tmux 3.8, Neovim 0.13.0.

```text
$ node .pi/verify/doctor.mjs
ok      pi    1.4.0
ok      tmux  3.8
ok      nvim  0.13.0
ok      git   2.56.0
target  0df52ca, 21 changed path(s) in the working tree
ok      TYPESAFE_API_KEY set — live judgment and web_answer drives are available
doctor: ready for npm run check, npm run verify, npm run smoke and the workbench drive

$ npm run check
Repository conventions pass
ℹ tests 1053
ℹ pass 1053
ℹ fail 0
```

The gate was briefly red during the proof on an unused import in an in-progress
test file; that work landed, the gate was re-run, and the result above is from
the final state. When a gate stops early, run the remaining stages yourself
(`npm run knip`, `npm run fallow`, `npm test`) and record each separately — a
partial gate is not a pass.

```text
$ npm run verify
23/23 checks passed

$ npm run verify -- --live
ok    live TypeSafe call — jev-1.13.0 noul=0.28
24/24 checks passed

$ npm run smoke
ok: real host loads 18 manifest extensions
ok: owned skills and workflow prompts discover and expand outside the repo
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
Local real-TUI acceptance passed at HEAD 0df52ca plus working tree.

$ node .pi/verify/workbench.mjs --upgrade
ok: prior HEAD footer upgrades through actual /reload
… (same workbench lines, fullscreen lifecycle)
Local real-TUI acceptance passed at HEAD 0df52ca plus working tree.

$ node scripts/judges-live.mjs --only review
ok   review lint — scope_creep 0.87
ok   review findings — 1 kept, 1 dropped (quoted text is not in the diff)
ok   plan review — 2 step(s) without verification, 0 without callers
all 3 judgments reached their judge
```

## Cleanup

The harnesses clean up in `finally`: smoke closes the pi process, fixture server
and temporary directory; the workbench kills its tmux server and removes its
fixture. Neither touches `~/.pi/agent`. A failure during setup, before the `try`
block, skips that cleanup: the proof run above left one `pi-workbench-ui-*`
directory and two orphaned Neovim processes this way. After a forced kill or a
crash, finish it by hand:

```sh
tmux ls                                                  # no pi-workbench-<pid> server
pgrep -fl 'pi-workbench-ui-|pi-smoke-'                   # no orphaned pi, tmux or nvim
tmux -L pi-workbench-<pid> kill-server                   # only for a leftover socket
find "${TMPDIR:-/tmp}" -maxdepth 1 \( -name 'pi-smoke-*' -o -name 'pi-workbench-*' \)
rm -rf "${TMPDIR:-/tmp}"/pi-workbench-ui-* "${TMPDIR:-/tmp}"/pi-smoke-*
```

Stop the processes before removing the directories: a surviving Neovim writes
its `~/.local/state` back into a fixture that was already deleted. A successful
workbench run can leave its tmux server visible for a second after it exits;
check again before calling it a leak.

Keep the evidence, not the fixtures: redirect each run to
`"${TMPDIR:-/tmp}/pi-verify-$(git rev-parse --short HEAD).log"` and paste the
lines that prove each feature into the report. Fixtures live outside the repo, so
`git status --porcelain` must still match the Target snapshot when the run is
clean; if it does not, something edited the tree and the evidence is invalid.

Report per feature: the command, the observed line, and any row you could not
drive plus the prerequisite that blocked it. Say separately what ran locally and
what CI will run — CI only runs `npm run check`; no hosted runner executes
`npm run smoke` or the workbench drive.
