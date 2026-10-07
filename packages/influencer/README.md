# pi-influencer

A self-contained Pi extension for reusable AI influencer identities and
image/video prompt recipes.

The extension reads bundled specialist guidance on demand. Nothing is installed
as a global skill and no settings change is required. The Seedance 2.5 prompting
skill is loaded only when a video recipe is selected.

## Tools

- `influencer_save` — persist a character's foundational prompt, consistency
  anchors, silhouette anchors, and style signature.
- `influencer_show` — retrieve the locked identity block verbatim.
- `influencer_list` — list saved characters and draft/locked status.
- `influencer_prompt` — build an image or Seedance 2.5 video prompt brief from
  a saved character and a recipe.

Characters are stored under `~/.pi/agent/influencers/<slug>.json`.

## Commands

```text
/influencer
/influencer list
/influencer maya sheet
/influencer maya sheet outfit=red leather jacket, black trousers
/influencer maya video duration=12 location=commuter train action=speaks to camera dialogue=...
```

`/influencer` opens an intake dialog for the character name and five identity
inputs. After the foundational prompt is written, the model saves it through
`influencer_save`.

## Recipes

Recipes are Markdown files in `prompt-recipes/`. They contain optional
frontmatter and can be added without changing the extension code. The bundled
`character-sheet` recipe creates one photorealistic contact-sheet image with:

- four full-body views across the top row: front, left profile, right profile,
  and rear;
- three close-up views across the bottom row: front, left profile, and right
  profile.

This intentionally produces one image rather than seven separate prompts.
Reference images can be attached in the image-generation tool; the recipe
instructs the model to treat the reference as the primary identity source.

The bundled `seedance-video` recipe builds Seedance 2.5 video prompts. It loads
`resources/seedance-2-5-prompting/SKILL.md` and its fal.ai reference notes for
that recipe. The skill covers reference roles, timelines when needed, physical
continuity, camera blocking, dialogue/audio distinctions, and ending state.
