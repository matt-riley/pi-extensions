# pi-router — pick the model the task deserves

Asks TypeSafe how hard the current task is, escalates to a frontier model when
the rating clears a threshold, and steps back down when a new task arrives.

## Why it looks like this

The shape is not taste, it is what measuring this repo's own 879-turn session
corpus said. Three findings drove it:

| Finding | Number | Consequence here |
| --- | --- | --- |
| Cost is concentrated | 6% of turns carried 77% of spend | Worth routing at all |
| Prompt features cannot tell hard from easy | frontier p50 61 chars vs mid 60 | Rules are out; judgement is in |
| Sticky escalation without a way down | +1665% spend | Escalate per *task*, then release |

And the two instruments TypeSafe could give:

| Instrument | AUC | Verdict |
| --- | --- | --- |
| `difficulty` (score 0–3) | **0.70** | what the router uses |
| `needs_frontier` (noul) | 0.55 | barely better than chance — rejected |

At `difficulty >= 1.5` the rating is 77% precise at 48% recall on labelled
turns, and catches 11 of the 12 most expensive turns in the corpus — including
both that a rules-based chooser confidently downgraded (*"Right, one last
chance. 4 different prototypes, nothing like the original site, go and impress
me."* at 2.18/3, and *"Stick to the task yo"* at 1.02/3).

## Behaviour

- **Judges at task boundaries** and when the previous turn ended in two or more
  failures (the stuck case), capped at 3 judgements per task. Continuations
  hold the decision already made.
- **Escalates only.** Nothing here ever downgrades a task in flight, because the
  rules that tried were wrong exactly where it mattered most.
- **Steps down only from a model it chose.** If you picked the model yourself,
  the router will not touch it — it forgets its own escalation the moment the
  session model stops matching what it set.
- **Respects your model scoping.** With `--models` / `enabledModels` in play,
  routing stays inside that list rather than reaching for the whole catalogue.
- **A missing judgement changes nothing.** Timeout, no key, unusable answer —
  the current model keeps working. Never spend less by accident.
- **Refuses a switch the target cannot hold.** The base model here reads 1M
  tokens while the Codex frontier models hold 272K, and this machine's p90
  request context is 452K. Escalating anyway would compact the session — losing
  the context the escalation was meant to reason over — so the router stays put
  and says why. In practice this makes escalation an early-task move, which is
  where the task-boundary design wanted it anyway.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_ROUTER` | unset (on) | `off` / `0` / `false` disables it for the process |
| `PI_ROUTER_THRESHOLD` | `1.5` | difficulty rating at which to escalate |
| `PI_ROUTER_FRONTIER` | `openai-codex/gpt-6-astra,openai-codex/gpt-5.6-sol,grok-4.6,qwen3.8-max,kimi-k3` | preference order, substring-matched against `provider/model` |
| `PI_ROUTER_TIMEOUT_MS` | `4000` | judgement deadline, after which the model is left alone |

In-session: `/route` for status and counters, `/route off` and `/route on`.

Qualify a pattern with its provider (`openai-codex/gpt-6-astra`) to pin which
subscription pays for it. **GPT models are restricted to `openai-codex` even
when the pattern is unqualified** — the same model is sold by several
subscriptions, and the catalogue order decided it once: a live run escalated to
`github-copilot/gpt-6-astra`. If no Codex GPT is available, GPT patterns are
skipped rather than billed to a reseller, and the next pattern is tried. A
pattern that names its provider is taken literally, and non-GPT patterns
(`grok-4.6`, `qwen3.8-max`) are never restricted this way.

## Knowing the threshold is set right

The judgement is a rating, not a verdict, so the threshold is a dial between
precision and recall. Two scripts measure it against this machine's own history:

```
node scripts/model-report.mjs       # what the deterministic rules would have done
node scripts/difficulty-report.mjs  # the judged rating, against real spend, with dollar costs
```

`difficulty-report.mjs` caches its judgements, so re-tuning costs nothing.
Committed evidence at the time of writing: `difficulty >= 1.5` → 77% precision,
48% recall, $23 of wrong escalations against $34 of frontier spend left on
cheaper models. Lower the threshold, find more, pay more.

## What it deliberately does not do

- **No tool or skill scoping.** Measured and rejected: 810 turns show shell in
  78%, edit 43% and read 38%, so scoping the common groups risks a turn that
  cannot work, and scoping the rare ones (memory, plan) left a 15%
  escape-hatch rate — worse than the disease. See `scripts/route-report.mjs`.
- **No per-turn switching.** It costs a full-context cache re-read (98.6% of
  everything this machine reads is a cache read) and buys nothing the task-level
  decision does not already get.
- **No downgrade on the fly.** A cheap model that needs a re-run costs more than
  the expensive one that worked, and that cost is unmeasured in either direction.

## Limits worth knowing

- The label behind every number here is *which model a turn actually ran on*,
  and model choice in the corpus was mostly per session. A turn rated hard
  inside an economy session counts against precision even if it would have
  benefited, so measured precision is a floor.
- Quality is unmeasured. The scripts price tokens, not wrong answers.
- The rating is Jev's judgement, so it inherits that model's calibration; the
  `legend` in the answer shows where the probability mass sat.
- Cost figures from some providers are junk (seven `openrouter/auto` records
  claimed −$2,351). Treat dollar shares as relative, not exact.

## Tests

`node --test packages/router/test/*.test.mjs` — 26 cases: the state builder
matching what was measured, threshold routing, model resolution and scoping, and
a fake-pi end-to-end pass over escalation, holding, stepping down, auth failure,
subagent children and the kill switch.
