---
name: lint-rules
description: Turn a recurring review finding into a native custom lint rule with pass and fail test fixtures, per language, using the repository’s installed linters. Use when implementing garden or quality prevention, oxlint JS plugins, ruleguard, go/analysis, Clippy denylists, or selene std rules.
---

# Native custom lint rules

Turn a mechanically checkable smell into a repository-native rule with regression fixtures. Prefer extending what the repo already runs over installing third-party lint plugins. Judgment-only patterns stay review guidance, not lint.

1. State the detection boundary, a failing example, legitimate passes and false-positive risks. Confirm the pattern does not need guesswork about intent.
2. Search existing linter config for a built-in rule that already covers it.
3. For TypeScript and Go, start from the quality scaffold instead of writing the wiring by hand. Run this from the checkout that contains `packages/quality` (the same tree as this skill):

   node packages/quality/scaffold.mjs typescript <rule-name> --dir <target>
   node packages/quality/scaffold.mjs go-ruleguard <rule-name> --dir <target>
   node packages/quality/scaffold.mjs go-analysis <rule-name> --dir <target>

   `<rule-name>` is kebab-case. The command writes a sample rule and one passing and one failing fixture. Replace the sample pattern and keep both cases. The generated files state the limits: Oxlint JS plugins are alpha and not covered by semver, type-aware rules cannot be JS plugins, and golangci-lint module plugins need a custom binary.

4. Pick the scaffold by what the rule needs:
   - TypeScript syntax: `typescript`.
   - Go syntax: `go-ruleguard` (gocritic).
   - Go types: `go-analysis`.
5. Rust: prefer `disallowed-methods`, `disallowed-types`, and `disallowed-macros` in `clippy.toml`. Avoid dylint (needs nightly).
6. Lua (selene, luacheck): neither has a plugin API. Prefer selene std YAML (`deprecated`, `must_use`) when it fits. Otherwise a headless Neovim tree-sitter query check in the repo test harness.
7. ast-grep is an optional syntax-only fallback when no native hook exists and a new tool install is approved. It is not a substitute for a native rule.
8. Wire the rule into the usual `check`/CI gate without lowering thresholds or blanket suppressions. Run the fixture through the repository’s normal test command. Verify installed tool versions from lockfiles or `--help`, and report a gap when a language has no supported extension point.
9. In `.agents/rules/<name>.md`, set `enforced-by: <tool>:<rule>` on the matching judgement rule (e.g. `oxlint:local/no-foo`, `golangci:ruleguard`, `clippy:disallowed-methods`) so `lint_change` skips the Jev question and lists mechanical coverage instead.
10. Report residual smells the rule cannot catch. Do not install tools, change global CI, or weaken existing policies without explicit approval.
