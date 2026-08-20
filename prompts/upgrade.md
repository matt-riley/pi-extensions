---
description: Upgrade-impact analysis for a package/library/runtime — breaking changes, refactoring candidates, and deprecations with a migrate-now-or-defer call
argument-hint: "<pkg> <to> [from]"
---

Analyze the impact of upgrading $1 to version $2 (from ${3:-its currently pinned version}) and produce a read-only report. Do not edit files and do not run the upgrade.

1. Resolve versions. Target = $2. Current = $3 if given, else read it from the nearest manifest (package.json deps/devDependencies, requirements.txt/pyproject.toml, go.mod, Cargo.toml); if nothing is pinned anywhere, ask. Include companion packages that move in lockstep (react → react-dom/@types/react, eslint → eslint-plugin-*, etc.).

2. Find the change history from current to target using the ecosystem sources below (web_fetch; GitHub URLs go through gh). Aggregate the full range — do not diff only the endpoints; call out any skipped major versions.

3. Extract from that history: breaking changes, deprecations added in the range, renamed/removed APIs, and newly recommended approaches.

4. Scan this codebase for affected usage with code_search/grep — one search per changed symbol, import, or API. For runtimes, also scan pinning surfaces: engines, .nvmrc, pyproject requires-python, rust-toolchain.toml, Dockerfile base images, CI matrix. If the changelog is thin or suspicious, fall back to an API diff (npm diff, .d.ts diff) for the named package.

5. Write the report in these sections:

- Summary — from → to, release count, headline changes, overall risk (low/med/high).
- Breaking changes hitting this codebase — severity-tagged "title — path:line", what changed, what breaks, and the fix. Include only what is actually used here.
- Refactoring candidates — old API still works but a newer approach is recommended: cost/benefit and affected files.
- Deprecations — for each: removal timeline, usage count here, migration effort, whether it already warns, then a verdict (migrate now / defer) with a one-line rationale.
- Notable but unaffected — changes worth knowing that do not hit this codebase.
- Verification — exact commands to run after upgrading (tests, build, type-check) plus deprecation-warning flags (node --trace-deprecation, python -Wd, cargo, etc.).

Severity: P0 upgrade blocker, P1 will break this codebase, P2 likely breakage or material behavior change, P3 low-impact.

Every breaking-change and deprecation claim must cite the changelog/release note it came from; flag anything unverified.

Ecosystem change sources:
- npm: `npm view <pkg> versions repository dist-tags`; GitHub releases/compare; CHANGELOG.md at the target tag.
- Python: PyPI JSON (`https://pypi.org/pypi/<pkg>/<to>/json`) → project_urls changelog; GitHub releases.
- Rust: crates.io API (`https://crates.io/api/v1/crates/<pkg>`) → repository → GitHub releases/CHANGELOG.
- Go: `go list -m -versions <pkg>`; module changelog / GitHub releases.
- Runtimes (Node/Python/Rust toolchain): official release notes and migration guides via web_search + web_fetch.
