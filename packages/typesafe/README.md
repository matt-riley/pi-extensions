# pi-typesafe — TypeSafe System One judgments for pi

One tool that turns `state` plus typed questions into calibrated judgments:
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
- `model` — optional override (default `TYPESAFE_MODEL` or `jev-latest`).

All questions are answered in **one request** and run in parallel, so batch
independent questions rather than calling repeatedly.

## Configuration

Environment only — no config file:

| Variable | Default | Purpose |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | *(required)* | Bearer token for `api.typesafe.ai`. Falls back to `LORE_TYPESAFE_API_KEY`, then to `typesafe.apiKey` in the lore config (`~/.config/lore/lore.json`, or `LORE_CONFIG` if set) — so one file covers pi and lore on machines where shell exports never reach a GUI-launched agent. |
| `TYPESAFE_MODEL` | `jev-latest` | Default model. |
| `TYPESAFE_BASE_URL` | `https://api.typesafe.ai/v1` | Override for a proxy or a test double. |
| `TYPESAFE_TIMEOUT_MS` | `30000` | Request timeout. |

The key is read at call time, so exporting it in your shell profile is enough
(or wherever pi picks up the environment). Requests are HTTPS to the configured
base URL, refuse redirects, honor cancellation, and never include the key in
errors.

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

## Tests

`node --test packages/typesafe/test/systemone.test.mjs` — request shape,
validation, transport, timeout/abort, error surfaces, and formatting, with the
network stubbed out.
