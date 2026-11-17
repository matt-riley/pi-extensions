# pi-extensions: AGENTS.md

## Structure

Each extension lives in `packages/<name>/` with `index.ts` as the pi
entrypoint, a `package.json` (metadata including name/description, but **no `pi` key**), and a
README. The **root `package.json` is the single registration point**: its
`pi.extensions` list is what pi loads when the repo is cloned into
`~/.pi/agent/extensions/`. Per-package `pi` keys would risk double
registration if pi's extension scanner recursed, so they stay out until each
package is published to npm on its own.

Repository layout: `shared/` holds helpers used by more than one package,
`prompts/` and `.agents/skills/` hold the bundled prompt templates and skills
(both registered in the root manifest), `scripts/` holds repository tooling that
never loads at runtime, `types/` holds the ambient stubs `tsc` uses, and
`.pi/verify/` holds the real-host verification recipe. Packages load as one
collection, not independent installs: a few import neighbours, as listed under
"Package dependencies" in the README. A new package also needs a row in the
README's extension table, which indexes every package.

## Conventions

- Zero installed runtime dependencies. Extension runtime imports are local modules,
  `node:` core modules, and pi's built-in `typebox`. SDK imports from
  `@earendil-works/pi-coding-agent` are type-only except the subagent host APIs:
  `getAgentDir`/`parseFrontmatter` in its entrypoint and
  `createAgentSession`/`DefaultResourceLoader`/`SessionManager`/`getAgentDir`
  in `spawn.mjs`. These are supplied by pi. `typebox`, `typescript`, and
  `@types/node` stay in devDependencies for local tooling; TypeScript is also
  used by the repository convention checker, never by extension runtime code.
  The workbench entrypoint may also import pi's host-provided `Input`, `SelectList`,
  `ScrollView`, `matchesKey` and `truncateToWidth` from `@earendil-works/pi-tui`.
  These widgets are injected into its plain `.mjs` logic; no runtime package is installed.
  The footer entrypoint likewise imports only `visibleWidth` and `truncateToWidth` and
  injects them into `extension.mjs`/`workspace.mjs`; its tests use `test/tui-fixture.mjs`.
  The decision-rows entrypoint imports only `truncateToWidth` and injects it into `rows.mjs`.
- `.pi/architecture.json` is live, not documentation:
  `packages/architecture/test/repo-rules.test.mjs` checks this repository during
  `npm test`. `shared/` is a leaf, packages must not import `scripts/` or each
  other, and import cycles fail. Existing cross-package imports sit in the
  rules' `except` list: move one into `shared/` and delete its line rather than
  adding an entry.
- The real `@earendil-works/pi-coding-agent` npm types are not used for
  `tsc`. See `types/pi-coding-agent.d.ts` for why (its published types are
  stricter than what pi's runtime actually enforces), and keep that stub's
  exports in sync with what `packages/*/index.ts` import. `types/mjs-modules.d.ts`
  types every sibling `.mjs` import as `any`; those modules keep their own
  correctness contract via `node --test`, not `tsc`.
- Runtime imports are allowlisted: `scripts/check-conventions.mjs` accepts
  `node:` modules, relative paths, `typebox`, and only the host exports named in
  its per-file `HOST_EXPORTS` map. A new runtime SDK or TUI import needs an entry
  there, or `npm run check` fails; other host imports stay type-only.
- The minimum supported pi is **1.4.0** (README "Requirements"). In
  `before_agent_start`, add text through `event.systemPromptOptions.sections`
  rather than returning `systemPrompt` (that replaces the whole prompt), and
  check `event.messageType` when a handler should only act on user prompts.
  `pi.sendUserMessage()` from a command passes `deliverAs`, because it throws
  while pi is busy without one.
- pi's `ctx.ui.notify(title, level)` takes exactly two arguments; there is no
  message slot. Flatten text into the title.
- Nontrivial logic (policies, parsers, state machines) goes in a plain `.mjs`
  module so `node --test` can cover it without a TS loader, with tests beside
  it in `test/*.test.mjs`.
- Non-test `.ts`/`.mjs` files under `packages/` and `shared/` stay under 1000
  lines (800+ is printed as a growth warning), and a helper that already lives
  in `shared/` is imported rather than re-typed: the conventions check names
  `usableNumber` and off-flag parsing explicitly. `npm run conventions` runs
  that checker alone when you want a fast answer.
- Prompt prose is product text: assert the sentence a rule states
  (`/Do not edit files\./`), not a keyword other sentences also contain
  (`/plan/i` passes a prompt that says to skip the plan). See
  `.pi/garden.md`.
- `prompts/*.md` may only name skills that exist under `.agents/skills/`; the
  conventions check validates those references against skill frontmatter.
- `npm run check` must pass before pushing: type-check with `tsc --noEmit`
  (its tsconfig `include` covers every `packages/**/*.ts` entrypoint, so new
  packages are checked with no script edits) and run the test suite.

## Verification recipe

Use `docs/verification.md` for what each check proves and misses, and
`.pi/verify/SKILL.md` for the runnable setup, fixtures and cleanup. Default
order: `npm run check`, then `npm run verify`, then `npm run smoke`; UI or
native terminal changes also need the real-terminal drives
(`.pi/verify/workbench.mjs`, `.pi/verify/jobs.mjs`).

## Skills

Keep skills lean: see `docs/skill-diet.md` before adding to or editing a
`SKILL.md`.

## Commands

Run these from the repository root after `npm install` (the tooling is
development-only).

- `npm test`: run the test suite (`node --test 'packages/**/*.test.mjs' 'scripts/**/*.test.mjs'`).
  For one package, `node --test packages/<name>` runs just its `test/*.test.mjs`.
- `npm run check`: the full gate, in order: repository conventions, `tsc --noEmit`, `oxlint
  --deny-warnings`, `oxfmt --check`, `knip`, `fallow dead-code`, then the tests.
  This is what has to pass before pushing.
- `npm run lint` / `lint:fix`: oxlint (`.oxlintrc.json`). Warnings fail too, so
  a finding is never left for later.
- `npm run format` / `format:check`: oxfmt (`.oxfmtrc.json`): 100 columns, code
  and JSON only. Markdown is excluded because reflowing prose buries real
  changes in a diff.
- `npm run knip`: unused files, exports and dependencies (`knip.json`).
- `npm run fallow`: dead code, cycles and dependency hygiene (`.fallowrc.json`).
  `npm run fallow:report` adds duplication and complexity: reported, not gated,
  because both are judgement calls rather than pass/fail.
- `npm run verify`: checks all manifest extension registrations against a stub pi.
  `-- --live` adds one real TypeSafe request and needs credentials.
- `npm run smoke`: exercises the real pi host with isolated fixtures and a local
  scripted provider; needs pi 1.4.0 or later on `PATH` (`PI_SMOKE_BIN` names
  another executable). See `docs/verification.md` for scope and limitations.
- `npm run coverage`: tests plus registration and smoke, written to
  `coverage/lcov.info`; needs pi and Node 24+.

Fixing beats suppressing: the only rule exceptions are the six in
`.oxlintrc.json`, each with its reason next to it. An inline `eslint-disable`,
`oxlint-disable` or `@ts-*` suppression also needs a reason, inline or in the
comment directly above it, or `npm run lint:comments` fails. `fallow fix` can remove unused
exports automatically, but it edited re-exports without their imports once, so run
the tests after any auto-fix.

## Commits

Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, …), imperative
subjects, focused diffs. CI runs the same `npm run check` gate through a
reusable `matt-riley-ci` workflow on pull requests and pushes to `main`; run it
locally before pushing instead of waiting for the run.
