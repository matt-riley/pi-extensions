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

Skill directories may be symlinks: the walker resolves them (and skips trees it
has already visited, so cycles terminate). A library root can therefore link
straight at a skills repository instead of copying it:

```sh
ln -s ~/code/agent-skills/skills ~/.pi/agent/skill-library/agent-skills
```

Directories named `archived` (at any depth, case-insensitive), `node_modules`
and `.git` are skipped. Retired skills must not be selectable: an agent would
otherwise follow guidance nobody maintains.

Trade-off: library-only skills are invisible to pi's `/skill:name` command
(pi never discovered them). The agent path is `skill_select` → `read` the
returned `SKILL.md`, which is what the tool is for.

## Other harnesses

The same ranker ships as a command, so agents without a pi extension (Claude
Code, Codex, Copilot, plain scripts) can search the library too:

```sh
node ~/.pi/agent/extensions/pi-extensions/scripts/skill-search.mjs "<task>" [--limit N] [--json] [--root DIR]
```

Exit codes: `0` matches, `1` none, `2` bad usage. Give the harness one line of
instruction — *skill library at `~/.pi/agent/skill-library`; search it before
improvising a specialist workflow* — and read the returned `SKILL.md`. The file
format is already the Agent Skills standard, so nothing else is needed.

## TypeSafe tiebreaker

Lexical ranking is deterministic and offline. When it is genuinely torn — the
top two scores within 1.5 points — one choice question over the top eight
candidates promotes the better fit. This is **on by default whenever a TypeSafe
key is reachable** (`TYPESAFE_API_KEY` or `LORE_TYPESAFE_API_KEY`); set
`PI_SKILL_SELECT_TIEBREAK=0` to keep selection entirely local.

```sh
PI_SKILL_SELECT_TIEBREAK=0 node ~/.pi/agent/extensions/pi-extensions/scripts/skill-search.mjs "review my code"
```

Only the task text and the candidate names/descriptions are sent — never the
library. It fails open: no key, separated scores, a provider error, or the model
answering `none_of_these` all leave the lexical order untouched.

## Ranking

Deterministic, no model, no network:

- exact name match `+10`
- whole-query phrase in the name `+6`, in the description `+3`
- query token in the name `+3` (name substring `+2`), in the description `+1.5`
- ties break alphabetically; entries scoring zero are dropped when a query is given

## Tests

`node --test packages/skill-select/test/library.test.mjs` — frontmatter parsing
(plain, folded, literal, quoted, BOM/CRLF), root resolution, nested discovery
with name fallback, symlinked directories including a cycle, dedupe, ranking,
and formatting.
