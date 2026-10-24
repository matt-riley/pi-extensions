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
5. This repository's bundled `.agents/skills` (resolved relative to the module, not the cwd)
6. `<cwd>/.pi/skills`
7. `<cwd>/.agents/skills`

Earlier roots win when two skills share a name. Other applications' private or
system skill roots are not searched automatically. Opt into a deliberately
reviewed portable collection with `PI_SKILL_LIBRARY` (or the CLI's `--root`).
Roots 3–4 and 6–7 overlap native Pi discovery; bundled workflows are also
available through `skill_select` when running outside this repository. Native
Pi package skills in other locations need explicit inclusion to be searched.

Skill directories may be symlinks: the walker resolves them (and skips trees it
has already visited, so cycles terminate). Only link collections you deliberately
want this agent to follow; a symlink is not a portability or trust boundary.

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

## TypeSafe selection

Lexical ranking is deterministic and offline, but it only sees words. When a TypeSafe
key is reachable (`TYPESAFE_API_KEY`, `LORE_TYPESAFE_API_KEY`, or `typesafe.apiKey` in the
lore config) one Choice question re-ranks the result **by intent**:

- **Wide pool.** Libraries of up to 150 skills are shown to the model whole (lexical only
  supplies the order), so a paraphrase with no word overlap can still win and a confidently
  wrong lexical winner gets challenged. Larger libraries send the lexical top 30.
- **Ordered by probability.** Results are sorted by the model's distribution and shown as
  `(p 0.83)` instead of a lexical score.
- **"None fit" is explicit.** When `none_of_these` has p ≥ 0.6 the result carries a note to
  proceed without a skill unless one obviously applies. Candidates stay visible.

Set `PI_SKILL_SELECT_TIEBREAK=0` to keep selection entirely local. Only the task text and
candidate names/descriptions are sent — never the library files. It fails open: no key, a
provider error (3-second budget, `TYPESAFE_TIMEOUT_MS` to override) or an unusable answer all
leave the lexical order untouched, and the call honours the tool's cancellation signal.

### Measuring it

`node scripts/skill-select-eval.mjs` runs `eval/cases.json` (54 cases) through lexical-only
and TypeSafe selection: 19 `history` cases (the `SKILL.md` an agent actually read after a real
`skill_select` call — a weak label), 25 hand-written `paraphrase` cases with little word
overlap, and 10 `none` cases where no skill should apply. Labels are not independent ground
truth; read the numbers as directional. Result on 2026-09-29 (115 skills, live Jev):

| | lexical | TypeSafe |
| --- | --- | --- |
| top-1 (44 labelled) | 26 | 39 |
| paraphrase top-1 (25) | 15 | 25 |
| wrong route (44) | 18 | 5 |
| correct "none fit" (10) | 1 | 6 |
| mean latency | 4 ms | ~480 ms |

The earlier tie-only design (reorder only when the top two scores were within 1.5) scored 29
top-1 and was removed. Re-run the eval after changing the questions, pool size or thresholds.

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
and formatting. Regression fixtures check that foreign roots require explicit
opt-in and bundled workflows resolve outside this repo. `scripts/workflow-skills.test.mjs`
checks portable metadata, manifest registration and realistic offline routing.
Those are wiring checks, not a benchmark of model behavior.
