# pi-extensions — AGENTS.md

## Structure

Each extension lives in `packages/<name>/` with `index.ts` as the pi
entrypoint, a `package.json` (name/description only — **no `pi` key**), and a
README. The **root `package.json` is the single registration point**: its
`pi.extensions` list is what pi loads when the repo is cloned into
`~/.pi/agent/extensions/`. Per-package `pi` keys would risk double
registration if pi's extension scanner recursed, so they stay out until each
package is published to npm on its own.

## Conventions

- Zero runtime dependencies. Import only pi's `typebox` built-in and `node:`
  core modules. Type-only imports from `@earendil-works/pi-coding-agent` are
  erased at runtime. `typebox`, `typescript`, and `@types/node` are
  devDependencies (tooling only — `npm run check`'s `tsc --noEmit` step),
  never imported at runtime beyond the erased type-only import above.
- The real `@earendil-works/pi-coding-agent` npm types are not used for
  `tsc` — see `types/pi-coding-agent.d.ts` for why (its published types are
  stricter than what pi's runtime actually enforces) and keep that stub's
  exports in sync with what `packages/*/index.ts` import. `types/mjs-modules.d.ts`
  types every sibling `.mjs` import as `any`; those modules keep their own
  correctness contract via `node --test`, not `tsc`.
- pi's `ctx.ui.notify(title, level)` takes exactly two arguments — there is no
  message slot. Flatten text into the title.
- Nontrivial logic (policies, parsers, state machines) goes in a plain `.mjs`
  module so `node --test` can cover it without a TS loader, with tests beside
  it in `test/*.test.mjs`.
- `npm run check` must pass before pushing: type-check with `tsc --noEmit`
  (its tsconfig `include` covers every `packages/**/*.ts` entrypoint, so new
  packages are checked with no script edits) and run the test suite.

## Commands

- `npm test` — run the test suite (`node --test 'packages/**/*.test.mjs'`).
- `npm run check` — the full gate, in order: `tsc --noEmit`, `oxlint
  --deny-warnings`, `oxfmt --check`, `knip`, `fallow dead-code`, then the tests.
  This is what has to pass before pushing.
- `npm run lint` / `lint:fix` — oxlint (`.oxlintrc.json`). Warnings fail too, so
  a finding is never left for later.
- `npm run format` / `format:check` — oxfmt (`.oxfmtrc.json`): 100 columns, code
  and JSON only. Markdown is excluded because reflowing prose buries real
  changes in a diff.
- `npm run knip` — unused files, exports and dependencies (`knip.json`).
- `npm run fallow` — dead code, cycles and dependency hygiene (`.fallowrc.json`).
  `npm run fallow:report` adds duplication and complexity: reported, not gated,
  because both are judgement calls rather than pass/fail.
- `npm run verify` — checks tool registration against a stub pi.

Fixing beats suppressing: the only rule exceptions are the five in
`.oxlintrc.json`, each with its reason next to it. `fallow fix` can remove unused
exports automatically, but it edited re-exports without their imports once — run
the tests after any auto-fix.

## Commits

Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, …), imperative
subjects, focused diffs.
