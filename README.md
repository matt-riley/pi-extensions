# 🧩 pi-extensions

Personal [Pi coding agent](https://pi.dev) extensions, built for my own use and
made shareable. Zero build step, zero runtime dependencies — each extension is
plain TypeScript loaded directly by pi.

## Extensions

| Package | Use it for |
| --- | --- |
| [`pi-exit`](./packages/exit) | `/exit` alias for pi's built-in `/quit`. |
| [`pi-plan-mode`](./packages/plan-mode) | Codex-like read-only `/plan` mode that writes a Markdown plan you edit before implementation. |
| [`pi-web-fetch`](./packages/web-fetch) | Browser-grade `web_fetch` / `batch_web_fetch` / `web_search`: clean markdown/HTML/text/JSON extraction, page metadata, GitHub URLs via `gh`, bounded-concurrency batches, keyless DuckDuckGo search. `web_answer` returns only the passages that answer a question. |
| [`pi-code-search`](./packages/code-search) | Faster, more reliable code discovery: `repo_map` / `code_search` / `file_outline` / `find_definition` with a persistent mtime-invalidated symbol cache, gitignore-exact inventory, and import/alias/re-export resolution. |
| [`pi-typesafe`](./packages/typesafe) | Calibrated judgments for the agent: `typesafe_ask` batches typed questions; `read_relevant` selects exact source ranges; deferred `find_code` finds implementations by behavior. Advisory web/MCP injection warnings preserve structured results. Environment-only config (`TYPESAFE_API_KEY`). |
| [`pi-skill-select`](./packages/skill-select) | On-demand skill selection: `skill_select` searches the whole local skill library — including roots pi never lists — and returns ranked matches with their `SKILL.md` paths, so the catalog costs no context until searched. `scripts/skill-search.mjs` is the same ranker as a command for other agents. |
| [`pi-diagnosis-nudge`](./packages/diagnosis-nudge) | Nudges on tool failures; after two failed revised checks, blocks mutations until a revision-bound diagnostic observation runs. |
| [`pi-done-gate`](./packages/done-gate) | Quietly nudges on unverified edits and leftover `[DEBUG-` tags; `measure_command` validates repeated, revision-bound benchmark/evaluation observations. |
| [`pi-until`](./packages/until) | `/until <cmd>`: keeps the agent working until a shell predicate exits 0, re-checking at every settle, capped, with a TSV decision log per iteration. |
| [`pi-guardrail`](./packages/guardrail) | Stops destructive tool use before it runs: deterministic rules for the 97% that are obviously fine, a TypeSafe judgment for the ambiguous middle, and an Approve / Deny / Suggest-an-alternative dialog for the rest. Refuses the catastrophic set outright. |
| [`pi-router`](./packages/router) | Rates how hard the current task is and escalates to a frontier model when it clears a threshold — once per task, never mid-task, and never downgrading a model you chose. Judged, because the rules measured 7% precision on this repo's own history. |
| [`pi-prompt-coach`](./packages/prompt-coach) | On-demand `/improve`: probe the repo, rewrite locally with Gemma4, verify intent with TypeSafe, and submit the rewrite with original-prompt fallback. |
| [`pi-influencer`](./packages/influencer) | Stores reusable AI influencer identities and builds recipe-driven image and Seedance 2.5 video-prompt briefs. |
| [`pi-subagents`](./packages/subagents) | Off-by-default in-process children: `/subagents on` to opt in, then the main session orchestrates `scout` / `reviewer` / `verifier` / `oracle` / `worker` / `researcher` (or custom `.md` types) and synthesizes. Live widget, `/subagents` to steer or stop. |
| [`pi-review`](./packages/review) | On-demand review with judgment behind it: `lint_change` scores a diff against this repo's standing preferences and commit rules, `blast_radius` lists the callers outside a diff and the symbols no test mentions, `verify_findings` drops findings whose own quotation is not in the diff before asking whether the rest hold. |
| [`pi-watch-pr`](./packages/watch-pr) | `watch_pr`: one read of a PR's checks on its head commit, merge state and unresolved threads, with a verdict (`needs-action` / `pending` / `ready` / `closed`). Read-only; `ready` is not a merge grant. |
| [`pi-jobs`](./packages/jobs) | Pi-native `/jobs` live logs, background commands and optional PTYs, human takeover, revision-bound exit evidence and opt-in Jev attention watches. No herdr/tmux required. |
| [`pi-workbench`](./packages/workbench) | Live-filtering `/ui` and `/files`, read-only `/changes` with retained review position and Neovim handoff, recoverable drafts and slash-command typo suggestions. |
| [`pi-footer`](./packages/footer) | Workspace, branch and actual work state first; `/footer details` reveals model accounting and extension statuses. |

### Package dependencies

These packages are published as separate directories but are not fully
independent — some import modules from their siblings, so deleting or
renaming one can break another:

- **`pi-workbench`** reuses **`pi-code-search`**'s Git-aware file inventory; its optional planning/subagent/footer actions appear only when those commands are loaded.
- **`pi-jobs`** reuses **`pi-workbench`** text sanitization and **`pi-done-gate`** check detection; it and the two gates use revision fingerprints from **`pi-subagents`**. **`pi-diagnosis-nudge`** and **`pi-done-gate`** consume the shared completed-job evidence adapter.
- **`pi-plan-mode`** imports `fetchSmart` / `formatWebFetchResult` /
  `isKnownFormat` from **`pi-web-fetch`**'s `fetch.mjs` and `format.mjs`
  (used to implement `plan_fetch_url`). Which other tools it allows is decided
  from their annotations at runtime, not from a sibling name list.
  `readOnlyHint: true` is trusted only for tools this repo registers.
- **`pi-skill-select`**, **`pi-typesafe`**, **`pi-guardrail`**,
  **`pi-router`**, **`pi-review`**, **`pi-done-gate`**, **`pi-diagnosis-nudge`**,
  **`pi-plan-mode`**, **`pi-safe-compact`**, **`pi-web-fetch`**,
  **`pi-prompt-coach`**, **`pi-subagents`**, **`pi-jobs`** and the `scripts/` classifiers all
  import from the shared `shared/systemone.mjs` — `askSystemOne` for the
  request, `usableNumber` for reading answers — and from its siblings
  `systemone-config.mjs` (endpoint and key), `systemone-request.mjs`
  (`validateRequest`, the state/question contract), `systemone-transport.mjs`
  (deadline and transports) and `systemone-session.mjs` (the store that carries
  Pi's context and token usage). One implementation of each, split by job, so a
  file stays readable instead of duplicating transport. Inside Pi, that request
  goes through `classify()` when a TypeSafe System One model is registered,
  and stays on the direct HTTP transport otherwise. The `scripts/` classifiers
  have no Pi model registry, so they stay on HTTP. Each call also appends a
  local `jev-decision` session entry (model, question ids, answers, latency,
  transport, outcome). State and question text stay out of that entry. See
  `packages/typesafe/README.md`.
- **`pi-plan-mode`** and **`pi-subagents`** both import the read-only bash
  allowlist from `shared/bash-policy.mjs` at the repo root, and both
  `pi-plan-mode` and **`pi-guardrail`** import the FIFO dialog serializer from
  `shared/dialog-queue.mjs` — two dialogs open at once stack and hang the tool
  batch.
- **`pi-plan-mode`** and **`pi-guardrail`** parse commands with
  `shared/shell-parse.mjs`, which is quote-aware and knows heredocs from shell:
  one answers "is this provably read-only?", the other "what could this
  destroy?", and both need to tell operators from literal text.

`pi-exit`, `pi-web-fetch`, `pi-code-search`, `pi-typesafe`, `pi-skill-select`,
`pi-diagnosis-nudge`, `pi-done-gate`, `pi-until`, `pi-review` and `pi-footer` have
no dependencies on other packages in this repo.

## Install

Clone the repo into pi's global extensions directory; pi auto-discovers the
extensions from the `pi` key in `package.json`:

```sh
git clone https://github.com/matt-riley/pi-extensions ~/.pi/agent/extensions/pi-extensions
```

then `/reload` in pi (or restart it). To update later:

```sh
git -C ~/.pi/agent/extensions/pi-extensions pull
```

then `/reload` again.

Check the tools are intact (loads the entrypoints through a stub pi, discovers
the local skill library, reports whether a TypeSafe key is visible):

```sh
npm run verify                 # offline
npm run verify -- --live       # also makes one real TypeSafe call
```

### Prompt templates and workflow skills

pi auto-discovers **extensions** from `pi.extensions`, but does **not** load
`pi.prompts` or `pi.skills` from auto-discovered extension directories. Those
resources load from installed packages or explicit settings. Register both in
`~/.pi/agent/settings.json`:

```json
{
  "prompts": ["~/.pi/agent/extensions/pi-extensions/prompts"],
  "skills": ["~/.pi/agent/extensions/pi-extensions/.agents/skills"]
}
```

Without this, the slash-command prompts in [`prompts/`](./prompts) (`/commit`,
`/review`, `/debug`, `/verify-setup`, `/mine`, `/triage`, `/garden`, `/upgrade`, `/migrate`, `/retro`, …) are
silently unavailable. Installed Pi packages load the same resources through
the root manifest instead.

Three owned, portable workflows live in [`.agents/skills/`](./.agents/skills):

| Skill | Entry points | Purpose |
| --- | --- | --- |
| `implementation-review` | `/review`, `/pr` | Read-only, defect-first review with grounded findings and test-quality checks |
| `test-driven-development` | `/test`, feature/bug work | Behavior-focused tests, independent expectations and tested vertical slices |
| `interface-design` | `/design`, `/refactor` | Small interfaces that hide complexity; `/design` proposes without editing |

`skill_select` and `scripts/skill-search.mjs` also search these bundled skills
from any working directory. Other applications' skill roots are **not** searched
unless explicitly included with `PI_SKILL_LIBRARY` or `--root`. Keep project-specific
skills under that project's `.agents/skills/`; do not import another harness's
system collection as an implicit dependency. Prompt skill references are validated
against this checkout on every `npm run check`, with no home-directory dependency.

## Requirements

- **Pi 1.4.0 or later.** The extensions use the 1.2.0 `before_agent_start`
  contract (`messageType`, `systemPromptOptions` sections) and rely on 1.4.0's
  fixes, such as concurrent extension dialogs. `npm run smoke` refuses older
  hosts; extensions themselves can't read the host version.
- **No added npm dependencies.** Imports are pi's `typebox` built-in and
  `node:` core modules. Most packages type-only-import `@earendil-works/pi-coding-agent`;
  `pi-subagents` also imports the host SDK at runtime (`createAgentSession`).

## Development

Dev tooling only — none of it ships with an extension:

| Command | Tool | What it guards |
| --- | --- | --- |
| `npm run lint` | [oxlint](https://oxc.rs) | correctness and suspicious patterns, warnings included |
| `npm run format` | [oxfmt](https://oxc.rs) | code and JSON at 100 columns |
| `npm run knip` | [knip](https://knip.dev) | unused files, exports and dependencies |
| `npm run fallow` | [fallow](https://docs.fallow.tools) | dead code, cycles, dependency hygiene; `fallow:report` adds duplication and complexity |
| `npm run coverage` | Node test runner | executable line/function/branch coverage and `coverage/lcov.info`, without an added dependency |

`npm run check` runs all four plus `tsc --noEmit` and the test suite. Every rule
exception is written down in the config next to the rule it disables, so the gate
stays honest instead of collecting suppress-comments.

### Classifiers

Three judgments that used to be made from memory in a prompt now live in
`scripts/`, so the same input gets the same answer twice and every one is
covered by `node --test`:

| Script | What it decides |
| --- | --- |
| `scripts/ci-triage.mjs` | one CI failure → `flaky`, `regression`, `infra`, `configuration` or `dependency`, with its confidence. `/triage --ci` calls it. |
| `scripts/promote-corrections.mjs` | a correction I gave more than once → the cheapest durable fix (`test`, `lint`, `guardrail`, `agents`, `prompt`, `none`) and how well existing guidance already covers it. `/mine` calls it. |
| `scripts/memory-check.mjs` | a candidate lore memory → `duplicate`, `contradiction`, `refinement` or `new`, naming the memory to update. `/retro` calls it. |

Each prints rather than applies, takes an injected `ask` in its tests, and says
when it could not judge instead of inventing a verdict.

## Related

- [matt-riley/lore](https://github.com/matt-riley/lore) — local-first memory
  and continuity for the Copilot CLI *and* pi (installed separately).
