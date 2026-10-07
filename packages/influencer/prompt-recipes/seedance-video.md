---
title: Seedance 2.5 video prompt
description: Build a copy-ready Seedance 2.5 prompt for fal.ai with explicit reference roles, action, dialogue, camera, and continuity.
alias: video
mode: video
guidance: seedance-2-5
slots: [duration, aspect_ratio, references, location, action, dialogue, audio, camera, ending]
---

Write one copy-ready Seedance 2.5 video-generation prompt for fal.ai using the locked character identity, the user's scene request, and the bundled Seedance 2.5 video-prompting skill.

Shot settings:
- Platform: fal.ai. Use the actual reference handles shown by the interface.
- Duration: {{duration}}
- Aspect ratio: {{aspect_ratio}}
- Reference roles: {{references}}
- Location: {{location}}
- Main action: {{action}}
- Dialogue: {{dialogue}}
- Audio plan: {{audio}}
- Camera: {{camera}}
- Ending state: {{ending}}

Apply these rules:

- Keep the character's locked identity anchors unchanged. Do not add unsupported character details.
- Use each attached reference for one clearly named purpose; say what must not transfer from it. Use only reference labels actually shown by the target interface.
- Keep one simple action as a simple shot. Use a short timeline only when timing, multiple actions, or cause-and-effect order matters.
- Preserve physical and visual continuity across the shot: identity, clothing, prop count, hand occupancy, direction, and state changes that matter.
- If exact dialogue audio is supplied, instruct the model to use it as the spoken track and synchronize visible speech to that audio. If it is only a voice sample, call it a voice reference and do not claim it contains the exact dialogue.
- Return the prompt itself, not an explanation. Do not leave template placeholders in the result.
