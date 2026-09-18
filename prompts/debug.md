---
description: Reproduce and root-cause a bug
argument-hint: "[symptom]"
---
Debug $@: reproduce it first, then find the root cause — not the symptom. Grep every caller of any function you suspect before editing. Fix it once where all callers route through; keep the diff minimal. If the fix is non-trivial, leave one runnable check behind.

When the failure is unclear, spend one `typesafe_ask` call: is it related to my change, which class is it, and where should I look first.
Before fixing, ask whether the evidence actually supports the root cause you just named. Plausible is not the same as supported.
