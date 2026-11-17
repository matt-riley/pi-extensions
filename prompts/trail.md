---
description: Audit this run's decision trail against what happened, then have another model family review it
---
1. Read `.pi/runs/decisions.tsv`. For each row this session wrote (after its last `start` row), check that it maps to a real decision or action in this conversation and that its evidence resolves and shows what the row claims. A fork, pivot or abandoned approach that shaped the work and is not logged is a gap: add it with `decision_log`. Never edit or delete a row; supersede a wrong one with a new row. If the file does not exist, say that no trail was kept and stop.
2. With subagents on, spawn one `oracle` subagent (it runs on another model family) with the trail path, and this session's transcript file if you can locate it. Ask for: decisions with weak or absent evidence, verification claimed without proof, choices that look risky in hindsight, and gaps a skim would miss. It reviews the trail; it does not redo the work.
3. End with an **Attention** section: `reviewed by <model>` on its own line, then each flag pointing at a row. "No flags" is a valid result. If no cross-family model was available, or subagents are off, say that instead of naming one.
