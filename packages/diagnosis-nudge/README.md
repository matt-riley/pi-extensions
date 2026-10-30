# pi-diagnosis-nudge — check the cause before writing the fix

When a tool call fails, this appends one line to that result:

```
Diagnosis check: name the root cause in one line, then ask `typesafe_ask` whether the
evidence you are about to cite actually supports it. Plausible is not the same as supported.
```

Ordinary tool failures remain advisory. A separate, deterministic checkpoint
now blocks further mutations after **two failed revised checks of the same
exact command**. No config or new dependencies.

## Failed-fix checkpoint

The checkpoint observes standalone verification commands recognized by
[done-gate](../done-gate/README.md), not arbitrary non-zero exits. Git fingerprints
include HEAD, staged/unstaged changes and nonignored untracked files.

- A failure counts only when the checked tree differs from the previous checked
  revision (or session-start baseline). Repeating a failing check on the same
  tree does not count twice. Unknown or tree-changing checks do not count.
- After two failed revised trees, native writes/edits, mutating shell commands
  and unknown tools are blocked, including nested codemode calls. Readers and
  exact previously observed checks remain available. A passing exact check
  resets its own failed attempts; unrelated successes and new input do not.
- `diagnosis_checkpoint({premise, command, expected_observation})` executes a
  read-only bash observation through normal tool hooks. A known unchanged
  revision, explicit successful exit and nonempty, untruncated output are
  required to release the gate. A failed/blocked/cancelled/stale observation
  leaves it pending. The tool returns the observation and revision as structured
  evidence in its result, not a model-authored claim of execution.
- State is stored as branch-local session entries and restored on resume,
  reload, switch and tree navigation. `/diagnosis` shows status;
  `/diagnosis reset` is an explicit human override, not a model-callable tool.

This enforces an executed checkpoint, **not** premise relevance or correctness.
A baseline without Git/HEAD or unsupported check syntax is outside its counting
contract. The existing read-only shell policy and tool annotations are
guardrails, not a sandbox; verification scripts and annotated readers remain
trusted. Already-running operations cannot be revoked. Approval and trust
policies still apply independently.

## Behaviour

- A failure arms the reminder and emits it **once per failure streak**, so a
  burst of related failures does not repeat itself.
- A `typesafe_ask` call clears the streak and re-arms it: the next unrelated
  failure gets its own reminder.
- Successes neither nudge nor clear anything. A passing `grep` does not mean
  the failing test passed.
- A failed `typesafe_ask` call never nudges about itself.

When a TypeSafe key is reachable, the failure is also classified —
`transient`, `environment`, `code_bug`, `permission`, `user_error`,
`no_failure` — and the output is checked for a credential. The class decides
the advice, because a code bug reported as "retry after the flake" is the
expensive version of this mistake, and a value that looks like a secret must
not be quoted again. Advice appears only at 0.6 confidence or above: below
that, wrong advice is worse than none. The triage runs once per distinct
failure, at most 30 times a session, takes a 2.5s deadline of its own, and any
failure of the judgment leaves the deterministic nudge exactly as it was.

A redaction is a leak signal in its own right: the redactor knows it replaced
a credential before the request left, and the model answering "does this
output contain a secret?" cannot see what was replaced — a first live run
scored the token in `GH_TOKEN=<redacted>` at 0.77 for exactly that reason. So
the count returned by the client raises the leak signal to certain, and the
model is asked anyway, because it catches the shapes no rule covers yet.
`PI_DIAGNOSIS_TRIAGE=off` turns the classification off; with no key it is
skipped silently.

## Repository env facts

When a bare command fails as “not found” and a launcher-backed alternative
succeeds in the same session (`python -m …`, `npx …`, and similar), the
extension remembers a candidate fact. After three confirming sessions whose
edited files do not overlap, the fact is shown on the next matching failure
as one extra line on that tool result — never in the system prompt.

Facts are stored under `<agentDir>/diagnosis-nudge/env-facts/` (one JSON file
per git root). Contradictions weigh five times a confirmation; at score zero or
below the fact is retired permanently. `/diagnosis facts` lists them;
`/diagnosis facts forget <id>` retires one explicitly. `/diagnosis reset` is
unchanged.

`PI_DIAGNOSIS_ENV_FACTS=off` (or `0`/`false`/`no`) disables learning and
display. No network calls are made.

## Tests

`node --test packages/diagnosis-nudge/test/nudge.test.mjs` — the state machine
and the content patch, including the re-arm and no-repeat cases.

`node --test packages/diagnosis-nudge/test/env-facts.test.mjs` — env-fact
learning, confirmation, contradiction, display, commands and the kill switch.
