# pi-typesafe — TypeSafe System One judgments for pi

Two tools. `typesafe_ask` turns `state` plus typed questions into calibrated judgments:
probabilities and confidence instead of prose. Backed by
[TypeSafe](https://docs.typesafe.ai)'s System One model, Jev.

```
typesafe_ask(state, questions, model?)
```

- `state` — text, or structured JSON (objects/arrays). Questions can reference
  it by path, e.g. `` `ticket.messages[0].text` ``.
- `questions` — map of id → `{ type, instructions, criteria }`:
  - `noul` — yes/no; returns the probability of yes.
  - `choice` — one of your options; returns the choice plus the distribution.
  - `score` — graded rating on ordered levels you describe.
- `model` — optional override (default `TYPESAFE_MODEL` or `jev-1.13.0`).

All questions are answered in **one request** and run in parallel, so batch
independent questions rather than calling repeatedly.

A request that could not be answered as asked is refused before it is sent: a state past Jev's 60000
characters, a state value JSON would drop (`undefined`, a function, a `Map` — the model sees the key
as absent), or a question naming a path the state does not have. Each refusal names the size, the
path or the question id, because an answer about absent state is indistinguishable from a considered
"no".

## Judging files and commands without loading them

Give `typesafe_ask` `paths` and/or `command` and the content is read locally and
sent to Jev; the agent only gets typed answers back, so nothing enters its
context. Questions reference `file.content`, `file.path` and
`command_output.output`.

- `paths` — files, directories or globs (`src/**/*.ts`), at most 255 files. One
  request per file, in parallel. A directory means its direct children unless
  `recursive`. Repo files only.
- `rank_by` — id of a `noul` or `score` question; files come back highest first.
- `command` — a read-only shell command; its output becomes state. Must pass
  both the read-only bash policy and the guardrail.

Because this sends content to a third-party API, paths must resolve inside the
repo (symlinks included), secrets and `.env` files are refused, binaries and
files over 1MB are skipped, and each file is cut at 60k characters (flagged
`file.truncated`).

## read_relevant

`read_relevant(path, goal, max_ranges?)` returns only the line-numbered ranges of
a large file that matter to a goal (exact file text, never generated). Windows
are rated one request each, and large winners are split and rated again for a
tight range. Files under 120 lines come back in full. Use plain `read` to edit.

## Configuration

Environment only — no config file:

| Variable | Default | Purpose |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | *(required)* | Bearer token for `api.typesafe.ai`. Falls back to `LORE_TYPESAFE_API_KEY`, then to `typesafe.apiKey` in the lore config — the same locations lore itself checks: `LORE_CONFIG`, then `lore.json` under `LORE_HOME`, `XDG_CONFIG_HOME` or `~/.config`, with the legacy `~/.copilot/lore.json` fallback. One file therefore covers pi and lore on machines where shell exports never reach a GUI-launched agent. |
| `TYPESAFE_MODEL` | `jev-1.13.0` | Default model. Pinned because the repo's thresholds were measured on it; re-tune them before moving to a newer Jev. |
| `PI_MASK_EMAILS` | off | Set to `1` to mask common email addresses in request-state string values. Leave off for identity/permission judgments. |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai/v1` | Override for a proxy or a test double. |
| `TYPESAFE_TIMEOUT_MS` | `30000` | Request timeout. |

The key is read at call time, so exporting it in your shell profile is enough
(or wherever pi picks up the environment). Requests are HTTPS to the configured
base URL, refuse redirects, honor cancellation, and never include the key in
errors.

A `429` (rate limited) or `529` (overloaded) is retried twice with exponential
backoff (0.5s, then 1s), as [TypeSafe asks](https://docs.typesafe.ai/api/errors.md),
within the same timeout and cancellation. That is the schedule for both
transports. Inside Pi 1.4 or later, `askSystemOne` uses
`ctx.modelRegistry.classify()` when a TypeSafe System One classifier is
registered, and passes `maxRetries: 0` so Pi does not apply its own retry
policy (408, 409, other 5xx, or a `Retry-After` that can outlast the call).
The 429/529 loop runs in the fetch wrapper instead, with the same two delays.
The model id on the wire stays `jev-1.13.0` (or `TYPESAFE_MODEL`, or the
per-call override) even when Pi's catalog entry is `jev-latest`. An explicit
`TYPESAFE_BASE_URL` still replaces the catalog host, which is how a proxy or
the smoke fixture is reached. A request still requires a local key
(`TYPESAFE_API_KEY`, `LORE_TYPESAFE_API_KEY`, or lore.json). Pi's stored login
is not used, so a session with only that login does not call Jev. The direct
POST is what runs when no classifier is registered.
Every `scripts/` classifier is in that group: those processes have no Pi model
registry.

The tool sends text/JSON state and choice/noul/score questions, not `assets` or
`box`, so it doesn't send the `TypeSafe-Danger-Zone-Images` opt-in header, which
TypeSafe wants only on requests that contain images. The classify call also
passes no images, and it sets `User-Agent` to null so Pi's client identity is
not added to a request that never sent one. Use the
[image API](https://docs.typesafe.ai/images) directly for those experiments.

Classify usage is copied onto the tool result, which is where Pi counts it
toward the session. A gate that is not a tool result or a compaction entry
(the guardrail, the router, the done-gate, prompt-coach) has nowhere in Pi
1.4 to record an extension `classify()` call, so those tokens stay out of the
session total. The answers themselves stay in today's shape: `noul`, score
probabilities, and `{ input_tokens, output_tokens }`.

## Example

```json
{
  "state": { "diff": "@@ -12,3 +12,9 @@ ..." },
  "questions": {
    "breaking": { "type": "noul", "instructions": "Does this change break existing callers?" },
    "risk": { "type": "score", "instructions": "How risky is this change to merge unreviewed?", "criteria": ["Safe", "Needs review", "High risk"] }
  }
}
```

Answers come back with the same ids: `breaking: noul 0.88`,
`risk: score 2.10 (confidence 0.79)` plus the level distribution.

## Design notes

- Malformed questions are rejected before any network call, with a message that
  says which question and why.
- Failures (missing key, HTTP error, timeout, cancellation, invalid JSON) are
  reported as tool errors — an explicit judgment request should surface its
  failure rather than silently return a default.
- Zero runtime dependencies: `node:` built-ins and pi's typebox only.

The 60,000-character state limit is enforced before the request, not by the
API: a 58,846-character state was measured answered in 2.1 seconds, against
0.99s for 29,846 and 1.89s for 54,846 (2026-10). Past it the caller is told to
send less rather than left to discover it as a truncated prompt.

Every request is built from a redacted copy of the state
(`shared/redact.mjs`): PEM private keys, JWTs, AWS, GitHub, OpenAI and Slack
tokens, bearer headers, URL userinfo (including short passwords), and 16-character-plus `key = value` assignments become
`<REDACTED:kind>`, and the caller's own API key is replaced wherever it appears.
The local home-directory prefix is also masked by default: `/Users/alice/project/app.ts`
becomes `<REDACTED:home>/project/app.ts`, preserving the useful path suffix. Common
email addresses are masked only with `PI_MASK_EMAILS=1`; default-off preserves
identities for permission judgments. This is best-effort masking of state string
values sent through the shared TypeSafe client, not object keys, question text,
or traffic to the main chat model. No global pi settings are changed.

`redactions` counts credentials; optional `privacyRedactions` counts personal identifiers,
so privacy masking is never mistaken for evidence of a credential leak. The combined
count is printed next to the answers, so a
redaction is never silent. Secrets are replaced rather than dropped, because a
question about *why* a command touches a credential still needs a sentence to
reason about.

## Decision ledger

Every call through `askSystemOne` appends one local session entry:

```js
pi.appendEntry("jev-decision", data);
```

That is Pi 1.4's `appendEntry(customType: string, data?: unknown): void`. The
custom entry stays in the session and does not enter the model context. The
ledger makes no network request of its own.

`data` holds the calling package or script, the model TypeSafe reported and the
model that was requested, question ids and kinds, the answers (including
probabilities or scores), latency, the transport (`classify` or `http`),
redaction counts, and an outcome. The outcome is `ok`, an error class
(`missing-key`, `validation`, `timeout`, `aborted`, `http`, `invalid-json`,
`network`, `classify`), or `fail-open` / `fail-closed` when the caller passes
`failurePolicy`. A policy outcome also keeps `errorClass`. The HTTP class
keeps the status code, not the response body.

State, secrets, and question text are not stored. Question instructions can
carry user data on `typesafe_ask`, so the entry keeps the id and the kind. If
an answer echoes the API key, that string is redacted before the entry is
written. A missing or throwing `appendEntry` is ignored: the judgment still
returns, or still throws, exactly as it would have.

The guardrail thresholds were measured on `jev-1.13.0`. That id is
`THRESHOLDS.tunedModel` in `packages/guardrail/judge.mjs` and `CURRENT.tunedModel`
in `scripts/judge-thresholds.mjs`. When the reported model differs,
`ctx.ui.notify(title, "warning")` runs once per session. The title says the
thresholds may need re-tuning and how to re-run `scripts/replay-corpus.mjs` and
`scripts/judge-thresholds.mjs`. Nothing is re-tuned automatically.

Guardrail entries export into the replay-corpus sample shape. Other features
ask different questions, so they are left out, and the ledger never kept the
command, so the exported action is `(not recorded)`. `judge-thresholds` can
still score the signals.

```sh
node scripts/replay-corpus.mjs --from-ledger session.jsonl --judge-json sample.json
node scripts/judge-thresholds.mjs sample.json
```

## Tests

`npm test` — `systemone.test.mjs` covers the direct HTTP transport, validation,
timeout/abort and formatting; `systemone-classify.test.mjs` covers the Pi
classify path, the `jev-1.13.0` pin, 429/529, redaction, and the fail-open /
fail-closed gates; `ledger.test.mjs` covers the session entry, what it refuses
to store, the drift warning, and a throwing `appendEntry`; `files.test.mjs`,
`relevant.test.mjs` and `spans.test.mjs` cover path resolution, the secret and
symlink guards, the command gate, fan-out, ranking and range selection;
`extension.test.mjs` covers the tool wiring. All with the network stubbed out.
