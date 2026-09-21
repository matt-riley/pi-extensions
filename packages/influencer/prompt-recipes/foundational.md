---
title: Foundational AI influencer character prompt
description: Build the reusable identity prompt that anchors the same synthetic creator across future image generations.
slots: []
---

Build the foundational character prompt from the five collected inputs and the bundled visual-language reference.

Output exactly these four sections:

1. **Foundational Character Prompt** — one clean, paste-ready prompt using the identity, face and features, defining quirk, skin and imperfection realism, niche-coded styling, lighting, camera and angle, setting, and style signature formula.
2. **Consistency Anchors** — 3–5 exact face and forward-visible identity phrases that must be reused verbatim.
3. **Silhouette Anchors** — 2–4 exact profile- and rear-visible phrases covering hair length and texture, how the hair falls at the nape, build, posture, and any visible rear mark. These anchors are required because the character may later be rendered in profile or from behind.
4. **Niche Alignment Notes** and **What Can Vary** — explain why the choices fit the niche and list safe shot-to-shot variation.

Use specific, observed detail rather than generic instructions to add flaws. Preserve natural asymmetry and realistic skin, hair, camera and lighting behavior. If the user supplied a reference image, treat it as the primary identity source and use the written anchors to reinforce it.

When the four sections are complete, call `influencer_save` for the draft character. Save the full foundational prompt, the 3–5 consistency anchors, the silhouette anchors, and the style signature. Do not silently guess missing age, gender, ethnicity, niche, or defining quirk.
