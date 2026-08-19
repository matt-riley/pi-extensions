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
| [`pi-subagents`](./packages/subagents) | Off-by-default in-process children: `/subagents on` to opt in, then the main session orchestrates `scout` / `reviewer` / `oracle` / `worker` / `researcher` (or custom `.md` types) and synthesizes. Live widget, `/subagents` to steer or stop. |

### Package dependencies

These packages are published as separate directories but are not fully
independent — some import modules from their siblings, so deleting or
renaming one can break another:

- **`pi-plan-mode`** imports `fetchSmart` / `formatWebFetchResult` /
  `isKnownFormat` from **`pi-web-fetch`**'s `fetch.mjs` and `format.mjs`
  (used to implement `plan_fetch_url`), and imports `CODE_SEARCH_TOOLS` from
  **`pi-code-search`**'s `tools.mjs` (to allow read-only discovery tools in
  plan mode's toolset).
- **`pi-plan-mode`** and **`pi-subagents`** both import the read-only bash
  allowlist from `shared/bash-policy.mjs` at the repo root.

`pi-exit`, `pi-web-fetch`, and `pi-code-search` have no dependencies on
other packages in this repo.

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

## Requirements

- **Pi** with extension support (auto-discovers `~/.pi/agent/extensions/*`).
- **No added npm dependencies.** Imports are pi's `typebox` built-in and
  `node:` core modules. Most packages type-only-import `@earendil-works/pi-coding-agent`;
  `pi-subagents` also imports the host SDK at runtime (`createAgentSession`).

## Related

- [matt-riley/lore](https://github.com/matt-riley/lore) — local-first memory
  and continuity for the Copilot CLI *and* pi (installed separately).
