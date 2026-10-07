# pi-router — pick the model the task deserves

A virtual model. Select `router/auto` in `/model`, and pi asks the router for a
physical model and thinking level before every request. It judges how hard the
current task is, escalates to the mid or frontier tier when the rating clears a
threshold, and returns to the base at the next task.

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

Select `router/auto` in `/model` (or `--model router/auto`). Selecting a
physical model instead deselects the router — ownership is a selection, not a
state machine. The base is what the router holds at when it is not escalating:
the first entry in the config's `base` list, defaulting to Luna.

- **Judges at task boundaries** and when the previous turn ended in two or more
  failures (the stuck case), capped at 3 judgements per task. The gate is the
  same prompt-shape heuristic the measurements used, but `reason` now tells the
  router a user turn from a continuation, so it no longer has to infer that part.
- **Continuations and retries are held, not judged.** A request after tool
  results returns the model that handled the turn, so prompt caches and thinking
  signatures stay valid. Retries are visible for the first time, and a retry
  stays on the model that failed rather than re-rolling the decision.
- **Escalates in tiers, per task.** At `difficulty >= 1.5` the task routes to
  the mid tier, and at `>= 2.5` to the frontier tier. Within a task the router
  only moves up: a model already at or above the target tier holds, so nothing
  downgrades a task in flight — the rules that tried were wrong exactly where it
  mattered most.
- **Routes the (model, thinking) pair.** The config is an ordered list of
  explicit pairs, not a model list with reasoning bolted on afterward. A cap of
  `low` filters out `Sol@xhigh` and `Sol@max`, leaving `Astra@low`; `xhigh`
  selects `Sol@xhigh`; `max` selects `Sol@max`. The router therefore never picks
  Astra first and silently clamps it.
  The selected cap is never exceeded. Continuations hold the exact pair, and a
  task boundary may choose a stronger pair when the cap allows it. Pi's levels
  are `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` — there is no
  `ultra`. The pair order is policy, not a benchmark claim baked into code, so
  it can be tuned in the file.
- **Comes back down only at a new task.** An easy rating at a task boundary
  returns to the base, releasing a frontier model or a raised thinking level. A
  stuck turn rated easy is still a stuck turn, so a failing continuation is
  never downgraded.
- **Requests outside the agent loop go to the base.** Compaction summaries and
  extension calls (`reason: "direct"`) carry no routing state and are not judged.
- **Respects your model scoping.** With `--models` / `enabledModels` in play,
  routing stays inside that list rather than reaching for the whole catalogue.
- **A missing judgement changes nothing.** Timeout, no key, unusable answer —
  the current model keeps working, and a failed judgement is counted and
  cooling down rather than retried every turn. Never spend less by accident.
- **Refuses a switch the target cannot hold.** The base model here reads 1M
  tokens while the Codex frontier models hold 272K, and this machine's p90
  request context is 452K. Escalating anyway would compact the session — losing
  the context the escalation was meant to reason over — so the router stays put
  and says why. In practice this makes escalation an early-task move, which is
  where the task-boundary design wanted it anyway.
- **Subagent children hold the base without judging.** Children inherit
  `router/auto`, so the extension still loads in them and registers the model
  they are pointed at; a child's `route()` sees `PI_SUBAGENT_CHILD` and answers
  with the base, no judgement call.

## Models

The model lists live in `<agent-dir>/router.json` (usually
`~/.pi/agent/router.json`), seeded with the built-in defaults on first load and
re-read on every judgement — edit it while pi runs and the change takes effect
at the next task, no restart:

```json
{
  "base": [{ "model": "openai-codex/gpt-5.6-luna" }],
  "mid": [
    { "model": "openai-codex/gpt-5.6-luna", "thinking": "xhigh" },
    { "model": "openai-codex/gpt-5.6-luna", "thinking": "medium" }
  ],
  "frontier": [
    { "model": "openai-codex/gpt-5.6-sol", "thinking": "max" },
    { "model": "openai-codex/gpt-5.6-sol", "thinking": "xhigh" },
    { "model": "openai-codex/gpt-6-astra", "thinking": "medium" },
    { "model": "openai-codex/gpt-6-astra", "thinking": "low" },
    { "model": "grok-4.6", "thinking": "medium" },
    { "model": "qwen3.8-max", "thinking": "medium" },
    { "model": "kimi-k3", "thinking": "medium" }
  ]
}
```

- Each key is a preference order of `{ "model", "thinking" }` pairs, matched as
  substrings of `provider/model`. A legacy string is accepted and means that
  model at the selected reasoning level.
- The selected virtual-model reasoning level is a hard cap. Candidates above it
  are filtered before model selection; the first remaining pair wins. A missing
  `thinking` follows the selected level.
- A missing key keeps the built-in default; an explicit `[]` keeps the tier
  empty, which is a decision — a rating that wants that tier holds the current
  model and says why.
- A broken file narrows routing to the defaults and warns once per session, so
  a typo costs a warning, not a session.
- Patterns are matched against the session's model scope first, so `--models`
  still caps what the router may reach for.
- `PI_CODING_AGENT_DIR` moves the file with the rest of the agent directory.

Qualify a pattern with its provider (`openai-codex/gpt-6-astra`) to pin which
subscription pays for it. **GPT models are restricted to `openai-codex` even
when the pattern is unqualified** — the same model is sold by several
subscriptions, and the catalogue order decided it once: a live run escalated to
`github-copilot/gpt-6-astra`. If no Codex GPT is available, GPT patterns are
skipped rather than billed to a reseller, and the next pattern is tried. A
pattern that names its provider is taken literally, and non-GPT patterns
(`grok-4.6`, `qwen3.8-max`) are never restricted this way.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `PI_ROUTER` | unset (on) | `off` / `0` / `false` skips judgements and holds the base for the process |
| `PI_ROUTER_THRESHOLD` | `1.5` | difficulty rating at which the router leaves the base (to mid or frontier) |
| `PI_ROUTER_FRONTIER_THRESHOLD` | `2.5` | rating at or above which the target is the frontier tier rather than mid (the two thresholds are ordered, so the lower starts mid and the higher starts frontier) |
| `PI_ROUTER_TIMEOUT_MS` | `4000` | judgement deadline, after which the model is left alone |
| `PI_ROUTER_SHARE` | `window` | `prompt` sends only the prompt to the judge, no conversation |
| `PI_ROUTER_PLAYBOOKS` | unset (on) | `off` stops the task-type judgement and playbook injection |

In-session: `/route` for status and counters, `/route off` and `/route on`.
`off` skips judgements and holds the base; it does not change which model is
selected. `/route status` prints the config path and the lists it is using.

## Playbooks

Skills only help when the model thinks to search for them. Playbooks don't wait
for that: at each new task (the same boundary gate the router uses), one
TypeSafe call asks what kind of work it is: `bug`, `feature`, `refactor`,
`investigation`, `autonomous` or `none`. The matching file in
[`playbooks/`](./playbooks) (six numbered steps) is appended to the system prompt
for every run of that task, and the footer shows `playbook: <type>`.

- **One judgement per task.** Follow-ups keep the task's playbook without
  another call. The next task boundary judges again and can drop it.
- **Nothing when unsure.** `none`, a chosen type below 0.5 probability, a
  missing key or a failed call all inject nothing. A wrong playbook costs more
  than a missing one. The 0.5 line is a dial, not a measurement.
- **No second call when routing.** With `router/auto` selected, the same batched
  call also rates difficulty, and `route()` uses that answer for the same prompt
  instead of asking again.
- **Not in subagent children.** Their task comes from the orchestrator.
- Each judgement is recorded as a `router-playbook` entry (type and whether it
  was a boundary), kept apart from `router-decision` so the routing reports are
  unchanged.

Unmeasured: whether the task-type answer is accurate on real prompts, and
whether a playbook changes outcomes. Both need a pass over the session corpus
before the types or the threshold are tuned.

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
pair order are curated design choices, not measurements. The claim that
`Sol@xhigh` or `Sol@max` should beat `Astra@low` is represented by the editable
order in `router.json`, not asserted by the router's measurement code.

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

`node --test packages/router/test/*.test.mjs` — 120 cases across the package:
the decision helpers and what was measured, pair-cap selection, the config
file's merge semantics, threshold routing, model resolution and scoping, the
session and metrics arithmetic, and 45 end-to-end cases against a fake pi that
drive the real `route()` over escalation, holding, step-down, retries, children,
capacity, live reload, and the kill switch.

## What an audit of this extension found

The router once audited itself on a frontier model, and it was worth the $4: it
found real defects. Fixed, each with a test:

| Finding | Was | Now |
| --- | --- | --- |
| The judgement budget never reset | Three judgements early in a session made every later task unroutable | A task boundary resets it |
| Step-down ignored the task boundary | A stuck, failing task could be downgraded mid-failure | Stepping down requires a new task |
| The router assumed ownership of any model | Start A → user picks B → router escalates → easy task restored **A** | `model_select` ends ownership; the baseline is captured immediately before switching |

Most of that ownership machinery no longer exists. The virtual-model port
replaced it with pi's own selection/dispatch split: a manually picked model is a
deselection, the baseline is configuration, and a decision that changes nothing
mid-flight is just a held continuation. What replaced the state machine is
router state on the session branch, which also follows forks and survives
compaction — things the module-level version could not do.
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
hide the real requirement; and a rating is not a prompt-injection boundary. The
router now sees every request, including steering and retries, but holds retries
deliberately: a provider-outage retry stays on the model that failed rather than
re-rolling the decision.

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
