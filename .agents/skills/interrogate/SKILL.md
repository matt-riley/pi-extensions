---
name: interrogate
description: Adversarial review where several models try to break a change and only findings a rerun reproduces are reported. Use for "interrogate", "stress test this", "find blind spots", or before landing a contested change. Needs subagents on.
---

# Interrogate

Report findings. Do not fix them.

1. **Scope and intent.** Scope is what the user named, else the branch diff from its
   merge base through the working tree. State the intent in two sentences from the
   request, commits and PR text. Ask when it is unclear: an adversary without the intent
   reports preferences.
2. **Fan out.** Call `review_panel` for the seats. Spawn one `adversary` per seat in a
   single turn, each with `isolation: "worktree"` and its seat's `model`. Give each the
   same brief: the scope, the intent, and nothing about the other seats.
3. **Rerun.** Pass each result and its worktree path to `rerun_findings`. A finding whose
   command exits 0 on rerun is dropped, whatever its prose says.
4. **Judge.** For each surviving finding, read the output and decide whether the failure
   breaks the intent from step 1. Drop it if it only shows behaviour the intent allows.
   Merge findings with one root cause.

## Report

- **Intent**: the restatement.
- **Findings**: command, output, how it breaks the intent, which seats found it. Say
  "no verified findings" when none survive.
- **Dropped**: per seat, how many and why.
- **Seats**: the models that ran, any seat that fell back to the parent model, and the
  panel's notes. A panel of one vendor is the same blind spots repeated: say so.
