# fal.ai: Seedance 2.5 prompt and reference notes

These are provider-specific notes derived from fal.ai's prompting guide. They are not universal Seedance syntax; check the current fal.ai interface for the actual controls and reference labels before generating.

## Reference assignment

- Give each uploaded asset one explicit role. For example, use a character image for identity and a separate location image for environment.
- Say what must **not** transfer from each reference: an outfit reference should not replace the character's identity; a motion reference should not import its subject or setting.
- fal's guide describes reference handles such as `@Image1`, `@Video1`, and `@Audio1`, assigned according to upload order. Confirm the displayed handles in the interface. Do not insert a space unless the UI shows one.
- When using multiple references, name the intended role for each handle in the prompt. The prompt text does not upload or attach the assets by itself.

## When to structure a timeline

Use explicit time blocks when action order, duration, dialogue timing, or camera cues matter. Keep each block to an observable event and carry the resulting physical state into the next block. For a simple shot, a compact description can be clearer than timestamps.

For example, specify that a character picks up one object with the right hand, keeps it there while crossing the room, and sets down that same object before the next action. Avoid vague continuity instructions when a specific hand, direction, or state change matters.

## Camera and physical continuity

Describe the camera's starting framing and screen position, then what event triggers each move. For a blocked subject, describe when it becomes hidden, how long it is hidden, and which identity, clothing, object, and motion details must match on reappearance. For physical action, include contact, resulting movement, reaction, and settling state when those details are important.

## Dialogue and audio references

Distinguish an exact speech recording from a sample used to suggest a voice. If the workflow accepts supplied speech as the actual audio track, identify that asset and request synchronization to its exact words and timing. If the workflow treats audio as a reference only, do not promise exact dialogue or perfect lip sync. Quote requested dialogue and keep the face unobstructed during speech.

## fal.ai source

Adapted from [Seedance 2.5 Prompting Guide + Real Examples](https://fal.ai/learn/devs/seedance-2-5-prompting-guide). The source covers timeline design, causal action, continuity through occlusion, camera blocking, assigning reference roles, dialogue, physical state, and continuing from a final frame. This reference summarizes those principles in original wording; it does not reproduce the source examples or its full API documentation.
