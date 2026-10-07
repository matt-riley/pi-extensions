---
description: Write or maintain this repo's .pi/verify recipe, proven by running it
argument-hint: "[create|maintain]"
---
${1:-create} the repo's verification recipe at `.pi/verify/SKILL.md`: how a future agent proves a change works in the real app, not just in tests.

It pays off where setup or acceptance is easy to miss: servers, UIs, external state, non-obvious launch steps. For a trivial CLI or library, say so and write a five-line recipe (check command, one real invocation, expected output, cleanup) instead of the full shape below.

The recipe has these sections: **Target** (what revision is being verified and how to record it), **Launch** (exact commands, env, ports; isolated config so user settings are never touched), **Doctor** (one health check to run before the first drive and after anything surprising), **Features** (a map of every user-facing feature: how to drive it, what to observe, and its prerequisites such as auth or OS), **Cleanup** (everything a run starts is stopped; evidence survives). `docs/verification.md` in pi-extensions is a real example.

## create

1. Derive the recipe from the repo: manifests and their scripts, README, CI workflows, existing test or smoke harnesses. Don't invent a command the repo doesn't have.
2. Prove every recipe by running it: launch, doctor, drive each feature once, clean up. Paste the observed result. A step you could not run is marked unproven with the reason, not written up as if it works.
3. Put any helper scripts beside the SKILL.md, executable, with their invocation in the body.

## maintain

1. Read the existing recipe and its feature map. Fix missing, duplicate or dead entries.
2. For each feature, re-read its source entry points and note likely drift with `path:line`. Scan recent churn (`git log --since=30.days --name-only`) for user-facing surfaces missing from the map, citing a real path before calling one missing.
3. Drive every feature live at least once, even when the source looks clean. Doctor before the first drive and after any failed one.
4. Triage what you find:
   - the recipe describes something wrong → doc drift, fix it in the recipe;
   - working behaviour the recipe can't drive → harness gap, fix it and re-drive it;
   - the app is actually broken → product regression. Report it separately; never edit product code or soften the recipe to hide it.
5. Only edit files under `.pi/verify/`. Report the outcome as **clean**, **changed** (with the edits) or **blocked** (what stopped it), plus which features were covered and which were unreachable and why.
