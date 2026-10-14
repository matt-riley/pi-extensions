# pi-diagnosis-nudge — check the cause before writing the fix

When a tool call fails, this appends one line to that result:

```
Diagnosis check: name the root cause in one line, then ask `typesafe_ask` whether the
evidence you are about to cite actually supports it. Plausible is not the same as supported.
```

That is the whole extension. No tools, no config, no dependencies.

## Why a nudge and not a gate

`tool_result` handlers can patch the result the model is about to read, but they
cannot inject a message — and a `before_agent_start` reminder would arrive one
turn too late, after the fix is already written. Patching the failure itself is
the only moment that can still change the next action.

It deliberately does **not** block anything. A gate on "failure then edit" would
misfire on ordinary non-zero exits — `grep` finding nothing, `test -f` returning
false — and a tool that blocks real work gets uninstalled.

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
`PI_DIAGNOSIS_TRIAGE=off` turns the classification off; with no key it is
skipped silently.

## Tests

`node --test packages/diagnosis-nudge/test/nudge.test.mjs` — the state machine
and the content patch, including the re-arm and no-repeat cases.
