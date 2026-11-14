# pi-prompt-coach — on-demand prompt improvement

Turn a rough request into a clearer one before sending it to the agent. A cheap
hosted model writes the rewrite and TypeSafe checks whether the intent survived.

For example:

```text
/improve fix the failing workflow on main
```

## Setup

You need one model key in your environment and TypeSafe credentials (see
[pi-typesafe](../typesafe/README.md#configuration)). Keys are read from
environment variables only; nothing is read from or written to a file. Without a
key, `/improve` says which variable to set and sends the original request
unchanged.

| Provider | Model ID | Key variable | Price per 1M tokens (in / out) |
| --- | --- | --- | --- |
| OpenAI (default) | `gpt-6-luna` | `OPENAI_API_KEY` | $0.10 / $0.50 |
| DeepSeek | `deepseek-flash` | `DEEPSEEK_API_KEY` | $0.15–$0.30 / $0.60–$1.20 (off-peak / peak) |

Prices were checked on 14 Nov 2026 at
<https://developers.openai.com/api/docs/pricing> and
<https://api-docs.deepseek.com/quick_start/pricing>. Luna is the cheaper of the
two, so it is used when both keys are set. If only `DEEPSEEK_API_KEY` is set,
DeepSeek is used. Thinking is switched off for both: this is a short rewrite
and the 60-second deadline would not survive a long reasoning pass.

The command:

1. probes the current repository for bounded facts such as branch, changed-file
   names, latest commit, and relevant CI status;
2. asks the hosted model to rewrite the request;
3. asks TypeSafe whether the rewrite preserves the original intent; and
4. submits the rewrite as the next user message if the intent check accepts it.

The intent check is a model judgment, not a guarantee that the rewrite is equivalent.

The rewrite is never shown in a separate editor and ordinary input is never
intercepted. If the model is unavailable, no key is set, the rewrite is
malformed, TypeSafe cannot verify it, or intent confidence is below the
threshold, `/improve` sends the original prompt unchanged.

With no argument, `/improve` uses the most recent user prompt in the session:

```text
/improve
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENAI_API_KEY` | unset | Key for the OpenAI provider. |
| `DEEPSEEK_API_KEY` | unset | Key for the DeepSeek provider. |
| `PI_PROMPT_COACH_PROVIDER` | first provider with a key | `openai` or `deepseek`. |
| `PI_PROMPT_COACH_MODEL` | provider default above | Rewrite model ID. |
| `PI_PROMPT_COACH_BASE_URL` | provider default | OpenAI-compatible endpoint. |
| `PI_PROMPT_COACH_TIMEOUT_MS` | `60000` | Rewrite deadline. |
| `PI_PROMPT_COACH_INTENT_TIMEOUT_MS` | `2500` | TypeSafe verification deadline. |
| `PI_PROMPT_COACH_INTENT_THRESHOLD` | `0.7` | Minimum intent-preservation probability. |

The rewrite request sends the prompt, working directory, and names-only probe
facts to the provider. TypeSafe receives the original prompt, the rewrite, and
those same bounded facts. Decision entries are stored in the session but do not
enter LLM context.
