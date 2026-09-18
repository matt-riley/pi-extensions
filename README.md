# 🧩 pi-extensions

Personal [Pi coding agent](https://pi.dev) extensions, built for my own use and
made shareable. Zero build step, zero runtime dependencies — each extension is
plain TypeScript loaded directly by pi.

## Extensions

| Package | Use it for |
| --- | --- |
| [`pi-exit`](./packages/exit) | `/exit` alias for pi's built-in `/quit`. |
| [`pi-plan-mode`](./packages/plan-mode) | Codex-like read-only `/plan` mode that writes a Markdown plan you edit before implementation. |
| [`pi-web-fetch`](./packages/web-fetch) | Browser-grade `web_fetch` / `batch_web_fetch` / `web_search`: clean markdown/HTML/text/JSON extraction, page metadata, GitHub URLs via `gh`, bounded-concurrency batches, keyless DuckDuckGo search. |
| [`pi-code-search`](./packages/code-search) | Faster, more reliable code discovery: `repo_map` / `code_search` / `file_outline` / `find_definition` with a persistent mtime-invalidated symbol cache, gitignore-exact inventory, and import/alias/re-export resolution. |
| [`pi-typesafe`](./packages/typesafe) | Calibrated judgments for the agent: `typesafe_ask` batches typed choice/noul/score questions over state and returns probabilities instead of prose. Environment-only config (`TYPESAFE_API_KEY`). |
| [`pi-skill-select`](./packages/skill-select) | On-demand skill selection: `skill_select` searches the whole local skill library — including roots pi never lists — and returns ranked matches with their `SKILL.md` paths, so the catalog costs no context until searched. `scripts/skill-search.mjs` is the same ranker as a command for other agents. |
| [`pi-diagnosis-nudge`](./packages/diagnosis-nudge) | Attaches one line to failed tool results: name the root cause, then check the evidence with `typesafe_ask`. Text only, never blocks a call. |
| [`pi-guardrail`](./packages/guardrail) | Stops destructive tool use before it runs: deterministic rules for the 97% that are obviously fine, a TypeSafe judgment for the ambiguous middle, and an Approve / Deny / Suggest-an-alternative dialog for the rest. Refuses the catastrophic set outright. |
| [`pi-subagents`](./packages/subagents) | Off-by-default in-process children: `/subagents on` to opt in, then the main session orchestrates `scout` / `reviewer` / `oracle` / `worker` / `researcher` (or custom `.md` types) and synthesizes. Live widget, `/subagents` to steer or stop. |
| [`pi-footer`](./packages/footer) | Always-on `/footer` status bar: model, thinking badge, extension statuses, context %, token counts, cost, directory, git branch. |

### Package dependencies

These packages are published as separate directories but are not fully
independent — some import modules from their siblings, so deleting or
renaming one can break another:

- **`pi-plan-mode`** imports `fetchSmart` / `formatWebFetchResult` /
  `isKnownFormat` from **`pi-web-fetch`**'s `fetch.mjs` and `format.mjs`
  (used to implement `plan_fetch_url`), and imports `CODE_SEARCH_TOOLS` from
  **`pi-code-search`**'s `tools.mjs` (to allow read-only discovery tools in
  plan mode's toolset), plus `SKILL_SELECT_TOOLS` from **`pi-skill-select`**'s
  `tools.mjs` (so planning can pull in a specialist skill without it living
  in the system prompt).
- **`pi-skill-select`**, **`pi-typesafe`** and **`pi-guardrail`** all import
  `askSystemOne` from the shared `shared/systemone.mjs` for the tiebreaker,
  `typesafe_ask` and the destructive-action judge respectively, so they share
  one request validation, timeout and error handling instead of duplicating
  transport.
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
`pi-diagnosis-nudge`, and `pi-footer` have no dependencies on other packages in
this repo.

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

### Prompt templates

pi auto-discovers **extensions** from the `pi.extensions` key in `package.json`,
but it does **not** read `pi.prompts` from auto-discovered extension
directories — prompt templates only load from installed packages or the
settings `prompts` array. Register the repo's `prompts/` directory in
`~/.pi/agent/settings.json`:

```json
{
  "prompts": ["~/.pi/agent/extensions/pi-extensions/prompts"]
}
```

Without this, the slash-command prompts in [`prompts/`](./prompts) (`/commit`,
`/review`, `/upgrade`, `/migrate`, `/retro`, …) are silently unavailable.

## Requirements

- **Pi** with extension support (auto-discovers `~/.pi/agent/extensions/*`).
- **No added npm dependencies.** Imports are pi's `typebox` built-in and
  `node:` core modules. Most packages type-only-import `@earendil-works/pi-coding-agent`;
  `pi-subagents` also imports the host SDK at runtime (`createAgentSession`).

## Related

- [matt-riley/lore](https://github.com/matt-riley/lore) — local-first memory
  and continuity for the Copilot CLI *and* pi (installed separately).
