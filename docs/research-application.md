# Applying the Pi workflow research

This is a design record for three additions: `/skill-search` for finding local
skills, `/usage` for inspecting session costs, and `/workflow` for guiding a
coding task through investigation, implementation, verification and review.
Most of the supporting tools already existed; the work connected them rather
than adding another orchestration framework.

For everyday setup, start with [Getting started](../README.md). For the new
commands, see [Using the additions](#using-the-additions) below.

## Research and scope

The comparison was made against commit `69b0baa378e772fd8158e4476d7745d581ef9b7a`,
using two supplied research documents dated 2026-11-01: “Executive Summary” and
“Pasted text(1).txt”. You do not need those files to use the commands. Both made
the same eight proposals, but neither inventoried this implementation. Their
suggested APIs and package statistics were not verified specifications.
The root `package.json` remains the only extension registration point.

| Research proposal | Existing implementation | Application |
| --- | --- | --- |
| Adaptive thinking/model router | `packages/router`: per-task difficulty, bounded stuck reassessment, retry/usage-cap handling, physical-model opt-out and decision records | Retain the measured router; no second router or new prompt-length rules. |
| Skill discovery and installation | `packages/skill-select`: shared local discovery, lexical/optional TypeSafe ranking; portable CLI; three owned workflow skills | Add `/skill-search <task>` for direct, offline discovery and a reviewable editor prompt. Installation stays a separate explicit task. |
| Workflow orchestration and background agents | `plan-mode`, opt-in `subagents`, `jobs`, bounded `until` | Add `/workflow <task>` to connect investigation, implementation, verification and review using these primitives. No automatic child enablement. |
| Agent testing/validation | Unit suite, registration verifier, real-host scripted smoke, workflow pilot and outcome record | Exercise new commands and workflow expansion in the existing smoke; add behavior tests for branch accounting and draft preservation. Preserve `/test` for repository behavior tests. |
| Debugging/observability | `diagnosis-nudge`, revision-bound evidence, Jev/router ledgers, transcript reporting scripts, `/debug` prompt | Keep the diagnostic checkpoint; do not introduce a conflicting `/debug` command or record raw prompts in another log. |
| Guards/sandboxing | Deterministic guardrail rules, ambiguous-action judgments/dialogs, read-only plan/subagent policies | Keep existing enforcement. Pi's v1.4.0 sandbox example is the concrete starting point for OS isolation; [integration notes](sandbox-integration.md) identify its dependency contract, unsandboxed fallback and uncovered job/child/file-tool paths. |
| Terminal UX | `workbench`, native background-job views, footer, toasts | Existing command discovery picks up `/skill-search` and `/usage`; retain the compact footer. |
| Usage/telemetry | Footer totals, native `/session`, context/model/router/subagent scripts | Add `/usage [--json]` for per-model active-branch tokens, caching, reported costs and outer tool failures, with unknown/zero accounting explicit. No new collector or external service. |

## Using the additions

After reloading extensions, run `/skill-search review a staged diff` to prepare
a specialist prompt, or `/usage` to inspect the branch without a model request.
`/workflow fix the retry bug` invokes a prompt template and starts normal coding
work. When the collection is cloned into an auto-discovered extension directory,
register its prompts explicitly as shown in [Getting started](../README.md#prompt-templates-and-workflow-skills).
Installing the extensions alone does not load those prompts.
Restart Pi if an already-loaded sibling module remains cached after `/reload`.

`/workflow` is guidance for the existing agent, not a persisted DAG executor.
It does not promise crash recovery, step replay, scheduling or deterministic
compliance. The current plan mode and tool gates remain the enforcement points.
The workflow prompt requires authorization from the actual task for publishing
or repository writes such as commits and pushes; it grants none itself.

## Verification and limits

Run `npm run check`, `npm run verify` and `npm run smoke`. The smoke loads the
actual Pi host in disposable configuration, expands `/workflow` from an unrelated
directory, and checks that `/skill-search` and `/usage --json` produce reports
without provider requests. Unit tests check cancellation/draft preservation,
local roots, model grouping, cache accounting, unknown/invalid costs and tool
result correlation. The workbench upgrade fixture includes the new footer helper.
See [verification.md](verification.md) for the full host/UI recipe.

`node .pi/verify/local-commands.mjs` checks command loading, RPC search reports,
zero-request branch accounting and workflow discovery in the actual Pi host
without opening a listener or contacting a provider. It does not test interactive
picker rendering or workflow prompt expansion; those require the terminal drive
and full smoke respectively.

These checks establish wiring and deterministic behavior. They do not establish
that the workflow prompt improves model decisions or productivity. Use the
existing [outcome record](workflow-evaluation.md#lightweight-outcome-record) for
a deliberately chosen experiment; a live model evaluation is not required just to load these additions.
