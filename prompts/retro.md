---
description: End-of-session retrospective that writes durable lore memories
argument-hint: "[summary]"
---
Review what this session did and save durable memories with lore_save so future sessions benefit. For each genuinely new item — do not re-save what lore already recalls — call lore_save once with the matching type:

- A decision or commitment the user made → `commitment`
- A preference the user expressed → `user_preference`
- A mistake or wrong path we took → `recurring_mistake`
- An approach we tried and rejected → `rejected_approach`
- A blocker → `blocker`
- Something left unfinished for a future session → `open_loop`

Keep each memory short and self-contained. Use the repository scope for project-specific items and global otherwise. At the end, list what you saved. Do not edit code.
