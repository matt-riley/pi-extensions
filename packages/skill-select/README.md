# pi-skill-select — on-demand skill selection for pi

One read-only tool that finds a skill by task and returns its `SKILL.md` path,
so skill **name + description pairs never have to sit in the system prompt**.

```
skill_select(query?, limit?)
```

Returns ranked matches — name, description, path — plus the reminder to read the
chosen `SKILL.md`. With no query it browses the catalog alphabetically.

## The point: no context tax

Pi lists every discovered skill (name + description) in the system prompt. That
is fine for a handful and expensive for a library. Put skills you want kept out
of the prompt in a directory pi does not scan, and this tool finds them on
demand:

```
~/.pi/agent/skill-library/<any-nested-layout>/SKILL.md
```

`PI_SKILL_LIBRARY` overrides or extends that root (colon- or comma-separated).
Searched roots, in priority order:

1. `PI_SKILL_LIBRARY`
2. `~/.pi/agent/skill-library`  ← the recommended home for non-listed skills
3. `~/.pi/agent/skills`
4. `~/.agents/skills`
5. `~/.claude/skills`
6. `~/.codex/skills`
7. `<cwd>/.pi/skills`
8. `<cwd>/.agents/skills`

Earlier roots win when two skills share a name. The discovery roots 3–6 are the
ones pi already lists, so the tool also searches skills you do keep listed —
useful as a fuzzy index even then.

Trade-off: library-only skills are invisible to pi's `/skill:name` command
(pi never discovered them). The agent path is `skill_select` → `read` the
returned `SKILL.md`, which is what the tool is for.

## Ranking

Deterministic, no model, no network:

- exact name match `+10`
- whole-query phrase in the name `+6`, in the description `+3`
- query token in the name `+3` (name substring `+2`), in the description `+1.5`
- ties break alphabetically; entries scoring zero are dropped when a query is given

## Tests

`node --test packages/skill-select/test/library.test.mjs` — frontmatter parsing
(plain, folded, literal, quoted, BOM/CRLF), root resolution, nested discovery
with name fallback, dedupe, ranking, and formatting.
