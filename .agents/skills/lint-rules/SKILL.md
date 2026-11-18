---
name: lint-rules
description: Turn a recurring review finding into a native custom lint rule with pass and fail test fixtures, per language, using the repository’s installed linters. Use when implementing garden or quality prevention, oxlint JS plugins, ruleguard, go/analysis, Clippy denylists, or selene std rules.
---

# Native custom lint rules

Turn a mechanically checkable smell into a repository-native rule with regression fixtures. Prefer extending what the repo already runs over installing third-party lint plugins. Judgment-only patterns stay review guidance, not lint.

1. State the detection boundary, a failing example, legitimate passes and false-positive risks. Confirm the pattern does not need guesswork about intent.
2. Search existing linter config for a built-in rule that already covers it.
3. Implement with the language’s native extension point below. Ship one **passing** and one **failing** fixture; run them through the repository’s normal test command.
4. Wire the rule into the usual `check`/CI gate without lowering thresholds or blanket suppressions.
5. Verify installed tool versions from lockfiles or `--help`; report gaps when a language has no supported extension point.

## TypeScript — Oxlint 1.94.0

- Local JS plugin: plain `.mjs` listed under `jsPlugins` in the Oxlint config.
- Test with `RuleTester` from `oxlint/plugins-dev` under `node:test`.
- JS plugins are **alpha** and not covered by semver.
- Type-aware rules **cannot** be JS plugins; use built-in type-aware linting via `oxlint-tsgolint`.

## Go — golangci-lint v2.15.0

- Small syntactic patterns: `gocritic` **ruleguard**.
- Patterns needing types: `go/analysis` analyser (`golang.org/x/tools` v0.52.0), tested with **analysistest**.
- Avoid golangci-lint **module plugins**; they require a custom binary.

## Rust — Clippy

- Prefer `disallowed-methods`, `disallowed-types`, and `disallowed-macros` in `clippy.toml`.
- Avoid **dylint** (needs nightly).

## Lua — selene 0.32.0, luacheck

- Neither has a plugin API.
- Prefer selene **std** YAML rules (`deprecated`, `must_use`) when they fit.
- Otherwise a headless Neovim **tree-sitter** query check in the repo test harness.

## ast-grep (optional fallback)

- Syntax-only patterns when no native hook exists and a new tool install is approved.
- Not a substitute for native rules when an extension point already exists.

Do not install tools, change global CI, or weaken existing policies without explicit approval. Report residual smells the rule cannot catch.