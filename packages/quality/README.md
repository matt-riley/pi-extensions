# pi-quality: clean up code smells and prevent recurrence

Run `/quality` in a Git repository. This starts an **editing workflow** in the
active coding agent, like `/agents`; it is not a read-only review or a promise
that a repository can be proven smell-free. It operates on the repository where
you invoke it, not just this extension collection. No startup or settle hook
runs checks or changes repositories automatically.

For an audit, use `/quality --scan`. It runs the same scanners and reports failures or unsupported languages, but never sends a cleanup request to the agent. Bare `/quality` keeps the editing workflow.

## Initial measured scan

The command finds the Git root and inventories tracked and nonignored untracked
files. In repositories with JS/TS, Go, Rust or Lua sources, it executes both
installed CLIs independently, without a shell, from that root:

```sh
crap . --format json --fail-above
deadwood . --format json --fail-on high
```

These interfaces were checked against installed `crap 0.1.6` and `deadwood 0.1.2`
and the tools’ sibling source repositories. Both binaries must be on `PATH`.
Missing tools, invalid JSON, killed processes, incomplete analysis and unexpected
exit codes and zero-file scans are errors, not clean scans. One failure does not prevent the other
scan. Each gets a two-minute deadline and a 128 KiB combined process buffer;
presentation is capped at 16,000 characters per tool and marked when truncated.
CRAP uses its native coverage discovery. Missing/unmatched coverage is an
unmeasured risk upper bound, not measured zero coverage.

No Git root means no cleanup request. Other languages still get a native-tooling
cleanup request, but these two CLI scans are explicitly skipped. Source detection
is a language hint, not proof that every file is analyzable; tool versions,
configured entrypoints, generated code, host-provided dependencies and coverage
matching must be checked during the workflow.

## Agent-driven remediation and prevention

The report is passed to the active coding agent as a follow-up request. It asks
for repository-wide cleanup: dead code/dependencies, complexity, duplication,
unsafe type escapes, swallowed errors, needless abstractions, weak tests,
suppressions and stale/redundant comments. Findings must be substantiated against
callers and runtime conventions before changes. Existing user edits and public
behavior must be preserved.

The workflow reuses the repository’s installed native lint/type/test tools,
adds missing mechanically checkable rules with positive and negative fixtures,
and wires prevention—including both applicable CLIs—into its normal check and
existing CI gate. It requests an independent final check and reruns after the
last edit. It forbids lowering thresholds, blanket exclusions or suppressions,
and requires approval before installing dependencies/tools, removing public
APIs, publishing or changing global Pi configuration.

This is **agent-driven**, not a standalone universal rewriting engine. Dispatch
is not completion: inspect the resulting changes and raw verification output.
A missing tool or unsupported analyzer may leave an explicitly reported gap.
No model, including the active coding agent, can guarantee complete removal of
all possible code smells.

## Documentation and comment rules

Comment classification must use the target language’s parser and declaration/type
information, not a prefix or symbol-name regex. Go documentation attached to
packages, declarations, fields and methods, JSDoc, Rust docs, Python docstrings,
licenses, directives and non-obvious rationale are preserved. Stale documentation
should be corrected, not deleted to silence lint.

For contextual review the agent can use the collection’s existing `typesafe_ask`
tool: ask separately about factual support and added information, consume a
validated closed result shape, and preserve uncertain comments. Type-safe output
checks structure, **not factual accuracy**. No paid/network judge belongs in a
required deterministic CI gate; a model score alone never authorizes deleting
documentation. Missing credentials or evidence must be reported, not guessed at.

This collection itself now runs `npm run lint:comments` in `lint` and `check`.
Its dev-only, strictly type-checked TypeScript AST rule in
[`scripts/comment-lint.mjs`](../../scripts/comment-lint.mjs) catches exact narration
of simple return, increment/decrement and call statements. It preserves JSDoc and
uncertain prose and does not parse other languages as JavaScript. It is a narrow
mechanical rule, not a semantic usefulness or documentation-truth classifier.
It can also check another Git repository explicitly:
`node <collection>/scripts/comment-lint.mjs <repository-root>` (using this
collection’s development-only TypeScript parser). For durable target CI, prefer
its native linter or a repository-local rule, not a path into a personal install.
Native rules for other repositories are built in those repositories by the
workflow, rather than silently installing a JS toolchain everywhere.

`/garden` complements this: sample recurring shortcuts, propose native lint rules
with legitimate passing cases, then implement and verify only after approval.
