# pi-review: semantic review of a change

Get a second look at a change: check it against the repository's preferences,
find callers it might affect, and filter review findings that the diff does not
support.

There are four on-demand tools and one command. `lint_change` and
`verify_findings` use TypeSafe judgments; `blast_radius` searches locally
without a model call; `rerun_findings` reruns an adversary's repro commands.
All four tools are deferred until tool search loads them, and none blocks a
tool call. `/rules add` checks a new rule against built-in and user rules before
writing `.agents/rules/<name>.md`.

## `/rules add`

Adds a judgement rule file after Jev compares the proposal to every existing
rule (built-ins and `.agents/rules/*.md`) in one request. Each comparison is a
choice among `distinct`, `covered`, `clarification`, and `conflict`. The command
shows any rule that is covered, clarifying, or in conflict, then asks for
approval before writing. It never overwrites an existing file; rejections,
unusable answers, covered/conflict overlap, and errors leave the tree unchanged.

With no flags, the TUI prompts for `name`, `subject`, `requirement`, `purpose`,
optional `applicability`, and an optional body. Non-interactive form:

```text
/rules add --name no-console-log --subject "…" --requirement "…" --purpose "…"
```

Requires `TYPESAFE_API_KEY` (same as `lint_change`).

## `lint_change`

Checks the diff against preferences written in AGENTS.md: unnecessary complexity,
extra scope, weak tests and similar concerns. Ordinary linters and type checks
still handle mechanical rules.

| Rule | What it asks |
| --- | --- |
| `overengineered` | Would a senior engineer call this more complicated than the problem requires? |
| `unrequested_abstraction` | A new seam (module, interface, generic or registry) that nothing calls for |
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
message, a task statement or test files is left out of the request, since a
question answered from nothing comes back as a confident "no".

### User rules (`.agents/rules`)

A repository under review can add judgement rules beside AGENTS.md: one Markdown
file per rule at `.agents/rules/<name>.md`. Each valid file becomes one more
yes/no question asked about the diff in the same shape as the built-ins above.
Missing `.agents/rules` means no extra rules; a malformed file is skipped with
a warning that names the file (printed as its own line in `lint_change` output).
Built-in rule ids win when a user file reuses a name.

Frontmatter fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Rule id, kebab-case, at most 80 characters |
| `subject` | yes | Short label shown on a finding line |
| `requirement` | yes | What the diff must satisfy |
| `purpose` | yes | Why the rule exists; included in the question |
| `applicability` | no | When to ask: `message`, `task`, or `tests` (same as built-in `requires`) |

The body after the frontmatter is optional context or examples. A future
`enforced-by` frontmatter field may tie a rule to a mechanical check; it is not
read yet.

Example:

```markdown
---
name: no-drive-by-format
subject: unrelated formatting mixed into a functional change
requirement: Do not reformat or reorder code outside the lines the task touches
purpose: Keep review focused on what changed for a reason
---

A whole-file prettier pass on a one-line fix is a violation.
```

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

- `support_N`: does the diff show the defect the finding names?
- `severity_N`: nitpick, worth fixing, or blocking?

Output is strongest first, each line carrying support, severity and whether the
quotation was found. Dropped findings are listed separately with the reason.

## `rerun_findings`

The run-proven half of `/interrogate`. Each `adversary` child ends its report
with a fenced `json` block of findings, each naming a `command` that exits
non-zero while the defect is present. The tool takes those reports unedited,
with the worktree each adversary ran in, and runs every command again:

```text
rerun_findings({ reports: [{ source, cwd, text }], timeout? })
```

- A command that exits 0 on rerun is dropped, whatever the report says. One
  that exits non-zero is kept with the exit code and the last 30 lines of the
  rerun's own output; the adversary's pasted `observed` text is never shown.
- The same command from two adversaries is one finding with both sources.
- A command that is blocked, times out (60 s default, 120 s cap) or is aborted
  is dropped with the reason. At most 20 commands run per call.
- A `cwd` that is not an absolute directory, or a report with no trailing
  `json` block, is listed as unread rather than guessed at.
- The output ends by saying that a non-zero exit proves a failure, not that the
  failure breaks the intent. The skill makes the parent judge that part.

**Execution path.** Each command runs as `cd '<cwd>' && <command>` through
`ctx.executeTool("bash", …)`, the way `diagnosis_checkpoint` and
`measure_command` run theirs. Nested calls go through the same `tool_call`
hooks as a model-typed command, so `guardrail` sees and can block each one.
This was chosen over a restricted runner confined to the worktree: a runner of
its own would have been a second command policy beside guardrail, and the
model-supplied command would have bypassed the one users configure. The `cd`
is a starting directory, not a sandbox; containment is guardrail's. Because
it executes commands, the tool is annotated destructive, so plan mode does
not treat it as read-only.

## Configuration

Shared with `pi-typesafe`: `TYPESAFE_API_KEY` (or `LORE_TYPESAFE_API_KEY`, or
`typesafe.apiKey` in the lore config), `TYPESAFE_MODEL`, `TYPESAFE_BASE_URL`,
`TYPESAFE_TIMEOUT_MS`. See `shared/systemone-config.mjs`. Inside Pi the request uses
`classify()` when a TypeSafe classifier is registered.

## Tests

`npm test`: `packages/review/test/*.test.mjs` covers routing, the mechanical
subject checks, quote extraction, the deterministic drop, `/rules add`
duplicate checks (stubbed Jev), and the rerun's keep/drop rules with a real
shell behind a stubbed bash tool. The network is stubbed;
`scripts/jev-questions.test.mjs` drives the question sets through the
production validators.
