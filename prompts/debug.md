---
description: Build a red feedback loop, then reproduce and root-cause a bug
argument-hint: "[symptom]"
---
Debug $@. Find the root cause, not the symptom, and do it from a feedback loop rather than from reading code.

1. **Build the loop first.** No hypotheses until you have run one command that is:
   - **red-capable**: it drives the real code path and asserts the user's exact symptom, not "didn't crash";
   - **deterministic**: same verdict every run (for flaky bugs, a pinned high reproduction rate: loop the trigger, add stress, narrow timing);
   - **fast**: seconds, not minutes;
   - **agent-runnable**: no human in the loop.
   Show the invocation and its output (redact secrets). Ways to build one, roughly in order: a failing test at the seam that reaches the bug, a curl script against a dev server, a CLI run diffed against a known-good snapshot, a replayed captured payload, a throwaway harness around one function, a fuzz loop, `git bisect run` between a good and bad state, a differential run of old vs new. If you catch yourself theorising before this command exists, stop. If you genuinely cannot build one, say what you tried and ask for access or a captured artifact.
2. **Minimise.** Cut inputs, config and steps one at a time, rerunning after each, until every remaining element is load-bearing.
3. **Hypothesise.** Write 3–5 ranked, falsifiable hypotheses: "if X is the cause, changing Y makes it disappear". A hypothesis without a prediction is a vibe. When the failure is unclear, spend one `typesafe_ask` call first: is it related to my change, which class is it, where should I look. Show the ranking; don't block on it.
4. **Instrument.** One variable at a time, each probe tied to a prediction. Tag every temporary log `[DEBUG-xxxx]` with one random suffix for the session.
5. **Fix.** Before editing, ask whether the evidence actually supports the root cause you named. Plausible is not the same as supported. Grep every caller of the function you are about to touch and fix it once where all callers route through; keep the diff minimal.
6. **Regression test, at a correct seam.** Write it before the fix and watch it fail, but only where it exercises the bug as it really occurs. If no correct seam exists, say so: the missing seam is a finding.
7. **Close the loop.** Rerun the original, un-minimised loop and show it green. `grep -rn "DEBUG-xxxx"` returns nothing. Throwaway harnesses are deleted. State the hypothesis that held in the commit message.
