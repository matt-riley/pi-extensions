# pi-review — semantic review of a change

Two on-demand tools for the part of review a linter cannot do. Both are
advisory: they return text, and neither blocks a tool call.

## `lint_change`

Judges the change against the preferences AGENTS.md states as prose, because
`tsc`, oxlint, oxfmt, knip and fallow already own everything shape decides.

| Rule | What it asks |
| --- | --- |
| `overengineered` | Would a senior engineer call this more complicated than the problem requires? |
| `unrequested_abstraction` | A new seam — module, interface, generic, registry — that nothing calls for |
| `speculative_scaffolding` | Code for a requirement that does not exist yet |
| `unnecessary_dependency` | A package or helper for something stdlib, platform, or installed already covers |
| `scope_creep` | Changes the task did not ask for (needs `task`) |
| `narrating_comment` | An added comment that restates the next line or narrates the edit instead of recording a reason or constraint |
| `weak_tests` | Added tests that would pass with the change reverted |
| `message_matches_diff` | The subject describes something the diff does not do (needs `message`) |
| `single_concern` | More than one logical change (needs `message`) |
| `commit_type_correct` | `fix`/`refactor`/`feat` does not match the kind of change |

The subject's mechanical shape is checked in code, not asked: a model applying
a regex is how a lint starts disagreeing with itself. A missing type, a capital
letter after the colon, a trailing period and a `BREAKING CHANGE` footer with
no `!` are reported by `conventionalProblems`.

Thresholds live beside each rule in `rules.mjs`. A rule that needs a commit
message, a task statement or test files is left out of the request rather than
asked against null state — a question answered from nothing comes back as a
confident "no".

The diff is cut at 45,000 characters (the state limit is 60,000) and the output
says when that happened, because a silent cut reads as a clean judgment.

## `blast_radius`

No model call. Finds every exported function, const or class the diff adds, removes
or edits (a hunk's enclosing definition counts, so a body-only edit is caught),
greps the tracked code for each name, and lists the caller files outside the diff.
A symbol no test file mentions is called out. It names the callers; proving the
change safe for them is still a run. Reads the diff with explicit `a/` `b/`
prefixes because `diff.mnemonicPrefix` changes the headers it parses. Checks the
first 25 definitions.

## `verify_findings`

Review findings that quote their code are checkable by string comparison: if the
quoted text is not in the diff, the finding is about code that is not there and
no judgment is needed. The survivors are asked two questions each, in one
request:

- `support_N` — does the diff show the defect the finding names?
- `severity_N` — nitpick, worth fixing, or blocking?

Output is strongest first, each line carrying support, severity and whether the
quotation was found. Dropped findings are listed separately with the reason.

## Configuration

Shared with `pi-typesafe`: `TYPESAFE_API_KEY` (or `LORE_TYPESAFE_API_KEY`, or
`typesafe.apiKey` in the lore config), `TYPESAFE_MODEL`, `TYPESAFE_BASE_URL`,
`TYPESAFE_TIMEOUT_MS`. See `shared/systemone-config.mjs`. Inside Pi the request uses
`classify()` when a TypeSafe classifier is registered.

## Tests

`npm test` — `packages/review/test/*.test.mjs` covers routing, the mechanical
subject checks, quote extraction and the deterministic drop. The network is
stubbed; `scripts/jev-questions.test.mjs` drives the question sets through the
production validators.
