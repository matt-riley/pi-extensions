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
- `npm run check` must pass before pushing: syntax-check every entrypoint with
  `bun build --no-bundle`, type-check with `tsc --noEmit`, and run the test
  suite.

## Commands

- `npm test` — run the test suite (`node --test 'packages/**/*.test.mjs'`).
- `npm run check` — syntax-check entrypoints, type-check (`tsc --noEmit`),
  and run tests.

## Commits

Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, …), imperative
subjects, focused diffs.
