# pi-influencer

A self-contained Pi extension for reusable AI influencer identities and image
prompt recipes.

The extension reads its bundled `resources/ai-influencer-prompt-builder/` files
on demand. Nothing is installed as a global skill and no settings change is
required.

## Tools

- `influencer_save` — persist a character's foundational prompt, consistency
  anchors, silhouette anchors, and style signature.
- `influencer_show` — retrieve the locked identity block verbatim.
- `influencer_list` — list saved characters and draft/locked status.
- `influencer_prompt` — build a prompt brief from a saved character and a
  recipe.

Characters are stored under `~/.pi/agent/influencers/<slug>.json`.

## Commands

```text
/influencer
/influencer list
/influencer maya sheet
/influencer maya sheet outfit=red leather jacket, black trousers
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
