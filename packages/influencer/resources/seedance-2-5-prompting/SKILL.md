---
name: seedance-2-5-video-prompting
description: Use when creating, revising, or adapting Seedance 2.5 video prompts for fal.ai, especially when a shot uses image, video, or audio references, dialogue, timed actions, camera movement, or continuity constraints. Not for still-image prompts.
---

# Seedance 2.5 Video Prompting

Turn a video idea into one concise, production-ready prompt. Treat it as a shot plan: define what the references control, what happens and in what order, what must remain consistent, how the camera behaves, and where the shot ends.

This guidance is bundled with `pi-influencer` and loaded only for video recipes. It is adapted from the fal.ai Seedance 2.5 prompting guide; it is not a reproduction of that guide and does not promise deterministic generation.

## Use this skill when

- Writing or revising a Seedance 2.5 text-to-video or reference-to-video prompt
- Assigning separate roles to character, location, motion, or audio references
- Planning a short scene with dialogue, multiple actions, object handling, camera movement, or visual continuity
- Diagnosing drift, repeated actions, bad lip sync, or inconsistent props in a generated clip

## Do not use this skill when

- Writing a still-image prompt; use the influencer image recipes instead
- The user asks only for voice design, audio generation, or video editing instructions unrelated to Seedance prompting
- The provider or interface is unknown and provider-specific input syntax would need to be guessed

## Inputs to gather

Identify only details that materially affect the shot:

- Desired duration and aspect ratio; if duration is unspecified, allow enough time for natural dialogue and action
- Location, subject, starting pose, and the main action
- Exact spoken line and whether a supplied audio file is the exact dialogue track or only a voice reference
- Camera framing and movement, if important
- Which attached image, video, or audio reference controls which element
- Important invariants and the final state of the shot

Do not ask for details already present in the request or references. If a missing choice materially changes the result, ask; otherwise choose a simple, low-risk default and make it explicit in the prompt.

## First move

Separate **reference roles** from **prompted action**. Give each attached reference one clear job, then write the shot around those roles. Never assume reference handles or upload order without checking the target interface.

## Workflow

1. **Set the shot format.** State duration, aspect ratio, one take or cuts, and natural real-time speed when those choices matter. Keep a simple single-action prompt simple; timelines are useful for ordered multi-step action, not mandatory decoration.
2. **Assign references explicitly.** State what each image, video, or audio reference controls and what must not transfer from it. A character image can control identity while a separate image controls location. Do not copy a reference's unrelated subject, background, pose, or lighting.
3. **Order actions causally.** For multi-step scenes, use short time blocks. Describe contact before reaction, and make each next action follow from the physical state left by the previous one.
4. **Track continuity.** Name the few details that must persist: character appearance, clothing, object count, which hand holds an object, direction of travel, location layout, and any important state change. For occlusion, state what disappears, for how long, and what must be unchanged when it reappears.
5. **Block the camera.** Describe its starting position, subject position in frame, movement, and the event that starts or stops that movement. Avoid vague directions such as “dynamic camera” when a specific framing is needed.
6. **Handle dialogue and audio precisely.** Quote exact dialogue. If a supplied audio file is the intended performance, identify it as the exact dialogue to preserve and request lip synchronization. A voice-reference sample is not necessarily an exact dialogue track; do not claim it guarantees exact words or lip sync. Keep the speaker's mouth visible while speaking and avoid actions that obstruct synchronization.
7. **Describe the ending.** State the final subject, prop, and camera state. For fluid or settling motion, describe where it goes and how it stops.
8. **Finish with a short constraint list.** Include only likely failure modes for this shot: identity drift, duplicated or disappearing props, repeated action, extra dialogue, subtitles, unwanted logos, or cuts. Avoid contradictory and generic negative-prompt clutter.

## Output contract

Return one copy-ready prompt, not a planning explanation. Use the provider's actual reference labels exactly as the interface presents them. Include a timeline only when event order or duration matters. Preserve exact dialogue and clearly separate dialogue, voice reference, and ambient audio.

## Guardrails

- The reference article describes prompting practice, not a guarantee that Seedance will follow every instruction.
- Provider interfaces, endpoint capabilities, reference limits, labels, and defaults can change. Verify provider-specific settings in the current UI or docs instead of hard-coding stale assumptions.
- Do not state that an audio reference will force exact speech or lip synchronization unless the selected workflow explicitly uses it as the dialogue track.
- Do not add actions, props, people, or scene details that the user did not request and the references do not establish.

## Reference files

- Use [fal.ai Seedance 2.5 prompting notes](references/fal-seedance-2-5.md) for fal.ai reference-label conventions and endpoint distinctions.
