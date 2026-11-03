# 🧩 pi-extensions

A personal collection of extensions for the [Pi coding agent](https://pi.dev).
Plan changes before editing, find your way around code, run background jobs, and
keep track of what the agent is doing. Built for my own use, shared for yours.

## Requirements

- **Pi 1.4.0 or later.** The collection relies on that version's fixes for
  concurrent extension dialogs. The smoke test rejects older hosts.
- **Install the collection together.** Some extensions import helpers from their
  neighbours. Removing individual package directories can break others; see
  [Package dependencies](#package-dependencies).
- Extensions are plain TypeScript loaded by pi, with no build step. Runtime
  imports use Node built-ins, pi's `typebox` and, for subagents, the host SDK.
  Local verification also needs the development dependencies installed below.

## Install

Clone into pi's global extensions directory and install the local tooling:

```sh
git clone https://github.com/matt-riley/pi-extensions ~/.pi/agent/extensions/pi-extensions
cd ~/.pi/agent/extensions/pi-extensions && npm install
```

Run `/reload` in pi, or restart it. Pi discovers the extensions through the root
`package.json`; you do not register each package separately.

`npm install` also makes `typebox` available to the local verifier. Without it,
`npm run verify` cannot load several entrypoints outside the pi host.

Try `/ui` to find commands, `/plan` to work through a change without editing, or
`/files` to insert a file reference into your prompt. Subagents stay off until
you explicitly enable them with `/subagents on`.

To update:

```sh
git -C ~/.pi/agent/extensions/pi-extensions pull
npm --prefix ~/.pi/agent/extensions/pi-extensions install
```

Then `/reload` again. Restart pi if an already-loaded helper remains cached.

To check local registration from the collection directory:

```sh
npm run verify                 # offline: entrypoints and local skills
npm run verify -- --live       # also makes one real TypeSafe request
```

The offline check uses a stub host: it proves registration, not that tools run
correctly in pi. See [Verifying pi extensions](./docs/verification.md) for the
full checks. Features backed by TypeSafe need credentials; their package pages
explain setup and what happens without a key.

### Prompt templates and workflow skills

The clone above loads **extensions**, but not their prompt templates or skills.
To use commands such as `/review`, `/debug` and `/workflow`, merge these entries
into `~/.pi/agent/settings.json` without replacing your other settings:

```json
{
  "prompts": ["~/.pi/agent/extensions/pi-extensions/prompts"],
  "skills": ["~/.pi/agent/extensions/pi-extensions/.agents/skills"]
}
```

Reload pi after changing settings. Without these entries, the prompt commands
are unavailable even though the extensions load. Installed Pi packages load
these resources from the root manifest instead of explicit paths.

Three bundled skills support the prompt templates:

| Skill | Entry points | Purpose |
| --- | --- | --- |
| `implementation-review` | `/review`, `/pr` | Find defects in a change without editing it. |
| `test-driven-development` | `/test`, feature/bug work | Test observable behaviour, including failures and edge cases. |
| `interface-design` | `/design`, `/refactor` | Simplify module boundaries; `/design` proposes without editing. |

`/skill-search <task>` finds a local skill and prepares a prompt for you to
review. `/workflow <task>` guides the agent through investigation, implementation,
verification and review; it does not grant permission to push, publish or deploy.

`skill_select` and `scripts/skill-search.mjs` can also find the bundled skills
from other working directories. Other applications' skill roots are searched
only when explicitly included through `PI_SKILL_LIBRARY` or `--root`. Keep
project-specific skills in that project's `.agents/skills/`.

## Extensions

| Package | Use it for |
| --- | --- |
| [`pi-exit`](./packages/exit/README.md) | Use `/exit` when your fingers insist on it. Same graceful shutdown as `/quit`. |
| [`pi-plan-mode`](./packages/plan-mode/README.md) | Work through a change in read-only mode, with an editable plan before implementation. |
| [`pi-web-fetch`](./packages/web-fetch/README.md) | Read web pages, search the web, and fetch GitHub content without opening a browser. |
| [`pi-code-search`](./packages/code-search/README.md) | Map a codebase, search its contents, and follow symbols to their definitions. |
| [`pi-typesafe`](./packages/typesafe/README.md) | Ask structured questions of TypeSafe's Jev model and get probabilities rather than prose. |
| [`pi-skill-select`](./packages/skill-select/README.md) | Find a relevant local skill when you need it, rather than loading the whole catalogue. |
| [`pi-diagnosis-nudge`](./packages/diagnosis-nudge/README.md) | Nudge the agent to check its diagnosis; pause edits after two failed revised checks. |
| [`pi-done-gate`](./packages/done-gate/README.md) | Remind the agent to check unverified code changes before it calls the work done. |
| [`pi-until`](./packages/until/README.md) | Keep the agent working until your check passes, within a limit you set. |
| [`pi-guardrail`](./packages/guardrail/README.md) | Check risky tool calls, ask for approval when needed, and refuse catastrophic operations. |
| [`pi-router`](./packages/router/README.md) | Route tasks to models, with optional escalation for harder work. |
| [`pi-prompt-coach`](./packages/prompt-coach/README.md) | Rewrite a rough request with a local model, then check that it still asks for the same thing. |
| [`pi-subagents`](./packages/subagents/README.md) | Delegate separate tasks to child agents, with live progress and controls. Off by default. |
| [`pi-review`](./packages/review/README.md) | Review a diff, find affected callers, and check whether review findings are supported. |
| [`pi-watch-pr`](./packages/watch-pr/README.md) | Check a pull request's CI, merge state and unresolved reviews in one report. |
| [`pi-jobs`](./packages/jobs/README.md) | Run background commands, follow their logs, and take over an interactive terminal. |
| [`pi-workbench`](./packages/workbench/README.md) | Find commands and files, browse changes, and recover a saved prompt draft. |
| [`pi-footer`](./packages/footer/README.md) | See your project, branch and work state; inspect usage and costs on demand. |
| [`pi-toasts`](./packages/toasts/README.md) | Show extension notifications as temporary cards instead of permanent chat rows. |
| [`pi-safe-compact`](./packages/safe-compact/README.md) | Carry selected context into a shorter session, with native compaction as a fallback. |

## Development

Run these from the repository root:

| Command | What it checks |
| --- | --- |
| `npm run check` | Conventions, types, lint, formatting, unused code and the test suite. |
| `npm run lint` | oxlint correctness rules; warnings fail too. |
| `npm run format` | Format code and JSON with oxfmt. Markdown is excluded. |
| `npm run knip` | Unused files, exports and dependencies. |
| `npm run fallow` | Dead code, cycles and dependency hygiene. `fallow:report` also reports duplication and complexity. |
| `npm run coverage` | Unit tests, registration checks and the real-Pi smoke under Node's LCOV reporter. Requires pi on PATH. |

Tooling is development-only. Rule exceptions belong beside the rule they disable,
with a reason. Prompt references to bundled skills are checked by
`npm run check`, without relying on a home-directory skill installation.

### Package dependencies

Package directories are not independent installations. These are the main links
between them:

- **workbench** uses **code-search**'s file inventory. Its optional planning,
  subagent and footer actions appear only when those commands are loaded.
- **jobs** uses **workbench** text sanitization and **done-gate** check detection.
  **diagnosis-nudge** also uses **done-gate** check detection. Jobs, subagents and
  both gates share revision fingerprints and completed-job evidence adapters.
- **typesafe** uses **code-search**'s inventory and **guardrail**'s path policy.
- **plan-mode** uses **web-fetch** for `plan_fetch_url`. It retains tools by
  runtime annotations, not a sibling-name list; `readOnlyHint: true` is trusted
  only for tools registered by this collection.
- TypeSafe-backed packages and the `scripts/` classifiers share the client in
  `shared/systemone*.mjs`: configuration, validation, transport and session
  accounting. In pi it uses `classify()` when a TypeSafe model is registered;
  standalone scripts use HTTP. Local `jev-decision` entries record answers,
  latency and outcome, not state or question text. See [pi-typesafe](./packages/typesafe/README.md).
- **plan-mode** and **subagents** share the read-only bash policy.
  **plan-mode** and **guardrail** share a quote-aware shell parser and a dialog
  queue, so simultaneous approval dialogs do not stack and hang.
- **done-gate** has no sibling runtime import, but its tests load **jobs**.

The other packages import only their own files and `shared/`, not sibling
packages. Most host SDK imports are type-only; subagents also loads the host's
session APIs at runtime.

### Classifiers

These scripts return advice rather than applying changes. Tests inject a fake
judge; a failed real request reports that it could not judge.

| Script | What it decides |
| --- | --- |
| `scripts/ci-triage.mjs` | Classify a CI failure as flaky, regression, infra, configuration or dependency, with confidence. Used by `/triage --ci`. |
| `scripts/promote-corrections.mjs` | Suggest a durable fix for a repeated correction: test, lint, guardrail, guidance, prompt or none. Used by `/mine`. |
| `scripts/memory-check.mjs` | Check a proposed memory for duplicates, contradictions or refinements. Used by `/retro`. |

## Related

- [Verifying pi extensions](./docs/verification.md) — what each check proves and misses.
- [Applying the Pi workflow research](./docs/research-application.md) — the design decisions behind discovery, usage and workflow commands.
- [Pi's sandbox example and this collection](./docs/sandbox-integration.md) — what would be needed for OS-level isolation; not an enabled feature.
- [Bounded workflow outcome pilot](./docs/workflow-evaluation.md) — a small recorded experiment, including its limits.
- [matt-riley/lore](https://github.com/matt-riley/lore) — local-first memory for the Copilot CLI and pi, installed separately.
