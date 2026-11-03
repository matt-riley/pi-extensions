# pi-prompt-coach — on-demand prompt improvement

Turn a rough request into a clearer one before sending it to the agent. It uses
a local Gemma4 model for the rewrite and TypeSafe to check whether the intent
survived.

For example:

```text
/improve fix the failing workflow on main
```

You need Gemma4 running through Docker Model Runner and TypeSafe credentials
(see [pi-typesafe](../typesafe/README.md#configuration)). Without them, the original
request is sent unchanged.

The command:

1. probes the current repository for bounded facts such as branch, changed-file
   names, latest commit, and relevant CI status;
2. asks the local Gemma4 model at Docker Model Runner to rewrite the request;
3. asks TypeSafe whether the rewrite preserves the original intent; and
4. submits the rewrite as the next user message if the intent check accepts it.

The intent check is a model judgment, not a guarantee that the rewrite is equivalent.

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
