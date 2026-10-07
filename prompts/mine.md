---
description: Mine past pi sessions for corrections I made more than once and propose durable fixes
argument-hint: "[--since N] [--project name] [focus]"
---

Mine past pi sessions for corrections I had to make more than once, then propose turning each into a durable fix.

1. Extract the raw material — do not read session JSONL directly:

   `node ~/.pi/agent/extensions/pi-extensions/scripts/mine-transcripts.mjs`

   Pass through any flags in $ARGUMENTS. Defaults to the last 30 days, newest 300 user messages. If the sample is thin (under ~50 messages, or a single project), widen with `--since 90` or `--all` and say so.

2. Cluster what came back. Look for: the same correction given twice ("don't do X", "use Y instead", "stop"), a re-explanation of something already said, a repeated format or workflow demand, and questions I had to answer that the agent could have answered itself.
3. Discard one-offs, task-specific instructions, and anything already covered by AGENTS.md or lore.
4. For each real cluster, pick the cheapest promotion that would stop it recurring:
   - mechanically checkable → a lint rule, test, or config change
   - destructive or irreversible → a `pi-guardrail` policy rule
   - always-applicable behaviour → one line in AGENTS.md (name the file)
   - a repeatable multi-step workflow → a new prompt or skill
   - a situational preference → a lore memory
5. Propose, do not apply. One block per cluster: the correction with one verbatim quote and its occurrence count, the proposed fix, and exactly where it goes. Order by how often it bit.
6. Wait for my pick. Apply only what I approve, then `lore_save` one memory per applied fix so `/retro` does not propose it again.
