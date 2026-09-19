# pi-router — pick the model the task deserves

Asks TypeSafe how hard the current task is, escalates to the mid or frontier
tier when the rating clears a threshold, and steps back down when a new task
arrives.

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

At `difficulty >= 1.5` the rating is 77% precise at 48% recall on the judged
sample and catches **7 of the 12** most expensive turns in it, including both
that a rules-based chooser confidently downgraded (*"Right, one last chance. 4
different prototypes, nothing like the original site, go and impress me."* at
2.18/3, and *"Stick to the task yo"* at 1.02/3). Dropping the threshold to 1.0
catches **12 of 12** at 65% precision, for roughly ten times the cost in wrong
escalations.

That 1.5 line was measured for "escalate at all", not for the size of the step.
The split between the mid tier and the frontier tier at 2.5 is a curated design
choice that has not been calibrated, and the mid list is a single verified entry
(`openai-codex/gpt-5.6-luna` — the model picked by hand when deepseek stalled),
not a benchmark result. Treat both as dials.

An earlier version of this file claimed 11 of 12 at 1.5. That figure belonged to
the `needs_frontier` question, which the router does not use — the audit that
caught it is summarised at the bottom of this file.

## Behaviour

- **Judges at task boundaries** and when the previous turn ended in two or more
  failures (the stuck case), capped at 3 judgements per task. Continuations
  hold the decision already made.
- **Escalates in tiers.** At `difficulty >= 1.5` it moves to the mid tier, and
  at `>= 2.5` to the frontier tier. It only moves up: a model already at or
  above the target tier holds, so nothing here ever downgrades a task in flight,
  because the rules that tried were wrong exactly where it mattered most.
- **Routes the (model, thinking) pair.** Luna at `xhigh` is the workhorse;
  frontier thinking defaults to `medium` so Astra is not paired with high-effort.
  A model switch always sets that tier's thinking, even when it is lower — do
  not carry Luna-max onto Astra. If the model stays put, thinking only rises,
  and only when the current model is already in the decision tier (already on
  Luna at medium, rating 1.8 → stay on Luna, set `xhigh`). A manual thinking
  change is not fought. Pi's levels are `off`, `minimal`, `low`, `medium`,
  `high`, `xhigh`, `max` — there is no `ultra`. These thinking defaults are
  curated, not measured.
- **Steps down only from a model it chose.** If you picked the model yourself,
  the router will not touch it — it forgets its own escalation the moment the
  session model stops matching what it set. When it does step down, it restores
  the user's thinking level too, if it owns that as well.
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
| `PI_ROUTER_THRESHOLD` | `1.5` | difficulty rating at which the router leaves the current model (to mid or frontier) |
| `PI_ROUTER_FRONTIER_THRESHOLD` | `2.5` | rating at or above which the target is the frontier tier rather than mid (the two thresholds are ordered, so the lower starts mid and the higher starts frontier) |
| `PI_ROUTER_MID` | `openai-codex/gpt-5.6-luna` | mid-tier preference order, substring-matched against `provider/model` |
| `PI_ROUTER_FRONTIER` | `openai-codex/gpt-6-astra,openai-codex/gpt-5.6-sol,grok-4.6,qwen3.8-max,kimi-k3` | frontier-tier preference order, substring-matched against `provider/model` |
| `PI_ROUTER_MID_THINKING` | `xhigh` | thinking level set when the router targets the mid tier. Unknown/blank values fall back to `xhigh`. Pi has no `ultra`. |
| `PI_ROUTER_FRONTIER_THINKING` | `medium` | thinking level set when the router targets the frontier tier. Unknown/blank values fall back to `medium`, so Astra is not paired with high-effort by default. |
| `PI_ROUTER_TIMEOUT_MS` | `4000` | judgement deadline, after which the model is left alone |
| `PI_ROUTER_SHARE` | `window` | `prompt` sends only the prompt to the judge, no conversation |

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

That evidence covers only the line at which the router leaves the current model.
It says nothing about where mid ends and frontier begins: the 2.5 split and the
mid list are curated design choices, not measurements, and the mid tier is one
verified entry rather than a benchmark result. The thinking defaults (mid
`xhigh`, frontier `medium`) are the same kind of dial — curated, not measured.

## What leaves your machine

Routing is a data-flow decision as much as a model one, so it is worth being
explicit: the judgement sends the prompt, the working directory, and (by default)
the last four turns — including assistant replies — to TypeSafe. An escalation
then serves that conversation from a different provider than the one you were
using. `PI_ROUTER_SHARE=prompt` narrows the first of those; nothing narrows the
second except `/route off`, or not escalating.

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

- **The tier split is not calibrated.** Only the 1.5 line was measured, and it
  was measured for escalating at all. The 2.5 mid/frontier boundary is a design
  choice and the mid list is a single verified entry, so treat the tier boundary
  as unvalidated until the reports accumulate decisions.

- **Measured precision is inflated, not a floor.** The judged sample was
  enriched (all 50 frontier turns, 40 of the 761 others) where the live base
  rate is closer to 6%, so live precision will be lower than 77% unless the
  threshold is raised. Two biases pull in opposite directions and neither is
  quantified: enrichment raises precision, while labelling turns by *the model
  they happened to run on* means a hard turn judged inside an economy session
  counts as a false positive.
- The label is spend, not need. Historical frontier use does not prove a cheaper
  model would have failed, and historical economy use does not prove it
  succeeded. Nothing here measures answer quality in either direction.
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

## What an audit of this extension found

The router once audited itself on a frontier model, and it was worth the $4: it
found real defects. Fixed, each with a test:

| Finding | Was | Now |
| --- | --- | --- |
| The judgement budget never reset | Three judgements early in a session made every later task unroutable | A task boundary resets it |
| Step-down ignored the task boundary | A stuck, failing task could be downgraded mid-failure | Stepping down requires a new task |
| The router assumed ownership of any model | Start A → user picks B → router escalates → easy task restored **A** | `model_select` ends ownership; the baseline is captured immediately before switching |
| `PI_SUBAGENT_CHILD` was read per prompt | pi-subagents clears it before the child's first prompt, so children *were* routed | Captured at factory time |
| A decision could land after `/route off` | A stale judgement still switched models | Re-checked after the await |
| Failed judgements were free and unlimited | A dead judge was retried every turn | Counted as attempts, with a cooldown |
| The score was coerced, not validated | `true` → 1, `[2]` → 2, `5` → 5 | A finite number inside the scale, or no decision |
| Capacity was checked after selection | The best model was picked, then refused, while a fitting one existed | Candidates are filtered by capacity first, with headroom and output reserve |
| `difficulty-report.mjs` judged empty state | An extraction refactor left a positional call where an object was expected | Object call, and the builder now throws on the wrong shape |

Still open, and written down rather than fixed: `difficulty` is a
probability-weighted mean, so two very different distributions can share a 1.5;
uncertainty and confidence are discarded; the difficulty scale mixes reasoning
complexity with the cost of being wrong; a 2,000-character prompt truncation can
hide the real requirement; a rating is not a prompt-injection boundary; and a
queued or steered prompt can bypass `before_agent_start` entirely, so a long
autonomous loop cannot be rescued from here.

## Metrics

`node scripts/router-report.mjs` reads the session transcripts plus the router's
own decision entries and reports what the routing is costing and how it is
landing. Everything in it is arithmetic over recorded facts; estimates say so.

Measured over 142 sessions, at the time of writing:

| Measure | Value |
| --- | --- |
| Model switches followed by a request | 35 (22 more were selected and never used) |
| Cold tokens paid at a switch (p50) | 38k, at p50 $0.0075 |
| Requests until the destination is warm again | p50 **1** |
| Frontier episodes | 17 covering 1,086 requests, $154.87 |
| Cost per frontier request vs the same sessions' cheaper model | $0.0365 vs $0.0041 |
| Estimated extra cost of those episodes | $82.85 (same tokens at the cheap rate; quality not compared) |
| Cache share inside episodes | 79% (corpus-wide: 98.6%) |

Two things this settled by measuring rather than arguing:

- **A switch is cheap and quickly amortised.** It pays full price for the prefix
  once — p50 38k tokens, three-quarters of a cent — and the next request is
  already mostly cache reads again. The audit's warning was right in principle
  and small in practice *at these context sizes*; the arithmetic changes at
  450k-token contexts, which is why the capacity filter exists.
- **A failed tool call is not a difficulty signal.** Turns inside frontier
  episodes fail *less* than the corpus average (11% vs 32%), because routine
  test-fail-edit loops run on the cheap model and design work does not. Anyone
  tempted to use tool failures as a quality label — including an earlier draft
  of this report — is measuring churn.

Each decision also records a `router-decision` custom entry (which does not
enter LLM context) with the rating, threshold, latency and outcome. That gives
the calibration loop the report prints: a *held* judgement followed by a manual
escalation is a miss, an *escalated* one followed by a manual retreat is
needless. Both are counted per rating band, so the threshold can be tuned from
live use rather than from the enriched historical sample. It needs a few dozen
judgements before the bands mean anything.
