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
- `model` — optional override (default `TYPESAFE_MODEL` or `jev-latest`).

All questions are answered in **one request** and run in parallel, so batch
independent questions rather than calling repeatedly.

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

`npm test` — `systemone.test.mjs` covers request shape, validation, transport,
timeout/abort and formatting; `files.test.mjs`, `relevant.test.mjs` and
`spans.test.mjs` cover path resolution, the secret and symlink guards, the
command gate, fan-out, ranking and range selection; `extension.test.mjs` covers
the tool wiring. All with the network stubbed out.
