---
description: End-of-session retrospective that writes durable lore memories
argument-hint: "[summary]"
---

Before running bundled scripts, locate this collection with `pi list` (managed installs) or
Pi's active prompt/extension configuration and discovery directories (clones). Respect
`PI_CODING_AGENT_DIR` and project overrides. Verify the root contains
`prompts/retro.md` and the scripts below. Substitute its absolute path for
`<collection-root>`; keep paths quoted and the working directory unchanged. If the location is
missing or ambiguous, report it and stop rather than guessing or using another checkout.

Review what this session did and save durable memories so future sessions benefit.

1. Draft the memories worth keeping — decisions, preferences, mistakes, rejected approaches, blockers, open loops. One claim each, short and self-contained.

2. Check each one against the store before saving it:

   ```bash
   node "<collection-root>/scripts/memory-check.mjs" --memory "<the memory>"
   ```

   It searches lore for the closest existing memories and judges the relation — `duplicate`, `contradiction`, `refinement` or `new` — and names the id to act on. Do what it says:

   - **duplicate** → update that memory instead of saving a second copy.
   - **contradiction** → decide which one is true, correct or forget the other, then save once.
   - **refinement** → amend that memory rather than adding a near-duplicate.
   - **new** → save it.

3. If it prints `Not checked` (no key, daemon down, the search found nothing), say so plainly and save only what you are confident is new. A failed check is not proof of novelty, and a near-duplicate costs every future recall.

4. Save each surviving item with lore_save once, using the matching type:

- A decision or commitment the user made → `commitment`
- A preference the user expressed → `user_preference`
- A mistake or wrong path we took → `recurring_mistake`
- An approach we tried and rejected → `rejected_approach`
- A blocker → `blocker`
- Something left unfinished for a future session → `open_loop`

Use the repository scope for project-specific items and global otherwise. At the end, list what you saved and what the check changed (updated, amended, or kept as new). Do not edit code.
