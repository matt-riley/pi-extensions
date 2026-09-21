# pi-prompt-coach — on-demand prompt improvement

Use `/improve` when a rough request would benefit from clearer structure:

```text
/improve fix the failing workflow on main
```

The command:

1. probes the current repository for bounded facts such as branch, changed-file
   names, latest commit, and relevant CI status;
2. asks the local Gemma4 model at Docker Model Runner to rewrite the request;
3. asks TypeSafe whether the rewrite preserves the original intent; and
4. submits the verified rewrite as the next real user message.

The rewrite is never shown in a separate editor and ordinary input is never
intercepted. If Gemma4 is unavailable, the rewrite is malformed, TypeSafe
cannot verify it, or intent confidence is below the threshold, `/improve`
sends the original prompt unchanged.

With no argument, `/improve` uses the most recent user prompt in the session:

```text
/improve
```

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_PROMPT_COACH_BASE_URL` | `http://127.0.0.1:12434/v1` | OpenAI-compatible local model endpoint. |
| `PI_PROMPT_COACH_MODEL` | `docker.io/ai/gemma4:latest` | Local rewrite model. |
| `PI_PROMPT_COACH_LOCAL_TIMEOUT_MS` | `20000` | Local rewrite deadline. |
| `PI_PROMPT_COACH_INTENT_TIMEOUT_MS` | `2500` | TypeSafe verification deadline. |
| `PI_PROMPT_COACH_INTENT_THRESHOLD` | `0.7` | Minimum intent-preservation probability. |

The local request includes the prompt, working directory, and names-only probe
facts. TypeSafe receives the original prompt, local rewrite, and those same
bounded facts. Decision entries are stored in the session but do not enter LLM
context.
