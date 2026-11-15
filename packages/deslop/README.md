# pi-deslop: catch machine-writing patterns in prose the agent just edited

When the agent edits a README or a doc, it tends to write `it's worth noting`,
`simple yet powerful`, or a negation set up to be reversed in the next clause.
This extension reads the prose each `edit` or `write` added and, when it finds
those patterns, appends a note to that tool's result. The agent sees the note
while the file is still in front of it and rewrites the sentences.

There is nothing to configure after you [install the collection](../../README.md#install).
TypeSafe verification needs a key; see [Configuration](#configuration).

## Deslop existing files or a directory

Run `/deslop docs/guide.md` to ask the agent to read the complete file and
rewrite its existing prose in place. Run `/deslop .` for the current directory
or `/deslop docs` for a named directory. Directory requests ask the agent to
recursively process prose files (`.md`, `.mdx`, `.markdown`, `.txt`, `.rst`, `.adoc`),
skipping dependency, generated and version-control directories and symlinks that
lead outside the selected directory. Empty directories should be reported without
creating files. Single-file requests still target only that file.

The rest of the argument is one path, so
spaces are supported without shell quoting. The command starts a normal agent
turn (or queues a follow-up if busy); it needs your current model, not a
TypeSafe key. It asks the agent to preserve facts, steps, caveats, links and code,
leave clear wording alone, and review the diff. Missing files should be reported,
not created. This is an editing request: it does not run an automatic regex replacement and
it cannot guarantee that a model preserves meaning. The usual post-edit checks still run
for supported prose files inside the session directory.

## What it does

It runs from `tool_result`, the hook pi fires after a tool finishes. A handler
there can add text to the result the model is about to read.

1. **Pattern check.** For a successful `edit` or `write` to a prose file inside
   the session directory, it scans the added text for a fixed list of patterns.
   An edit is charged only for patterns it added: text that was already in the
   replaced passage is ignored.
2. **TypeSafe checks the findings.** One request asks Jev two yes/no questions:
   do the flagged patterns make this text worse for its reader, and is the text
   itself about writing patterns (a style guide quoting the phrases)? Findings
   Jev dismisses are dropped and the agent sees nothing.
3. **The note.** Confirmed findings are listed on the edit result, each with the
   sentence it was found in and the fix, followed by a request to rewrite them
   with the meaning kept.
4. **TypeSafe checks the rewrite.** When the agent next edits the flagged text,
   the new text is scanned again and one more request asks whether it makes the
   same claims as the flagged text and whether it still reads as formula prose.
   A rewrite that passes is silent. One that changed the meaning, or kept or
   swapped the pattern, gets a second and final note.

A file gets at most two notes per prompt. The extension never blocks a tool
call and never edits a file.

## What it looks for

The list comes from two skills, read in full:
[adamdunkels/deslop-text](https://github.com/adamdunkels/deslop-text/blob/main/skills/deslop-text/SKILL.md)
(its numbered warning signs, cited as `W1` to `W53`) and
[stephenturner/skills deslop](https://github.com/stephenturner/skills/blob/main/deslop/SKILL.md)
(cited as `deslop rule N`). The detector phrase lists are derived from these
MIT-licensed sources; the extension logic and advice are written for this
collection. Only the signs a regular expression can decide are checked here:

| Severity | Signs |
| --- | --- |
| High (strong) | Filler phrases (W1), "not X, it is Y" and "not X but Y" contrasts (W2), marketing adjectives (W5), generic openings (W6), paired adjectives (W9), "excited to announce" (W15), "whether you're X or Y" (W16), throat-clearing pivots (W17), corporate and internet cliches (W21, W25, W36), runs of short punchy sentences (W34), one-line closers such as "that's it", parenthetical asides repeated three times |
| Medium (weak) | Dash asides, em dash or double hyphen (W3), self-posed rhetorical questions (W4), stacked hedging (W8), text narrating its own structure (W10), mechanical transitions (W11), exclamation clusters (W18), emoji as emphasis or in headings (W23, W30), sincerity intensifiers (W38), "serves as" for "is" (deslop rule 3), "X, not Y" contrasts (contrastive framing), one subject renamed with a new synonym each time |
| Low (weak) | "very" (W20), curly quotes (W27), "quietly" (W45), unicode arrows (deslop rule 9), invented hyphenated labels, forced groups of three, sentences that fit any project's docs |

A strong sign is enough for a report on its own. A weak sign counts only
beside others in the same paragraph: a medium and a low, or three lows, report
together, and the same signs spread over different paragraphs do not. This keeps
a long file from collecting a report out of scattered punctuation.
Curly quotes need four occurrences and arrows need two before they count.
The filler list covers `delve`, `leverage`, `utilize` and `it's worth noting`,
including `delved`, `leveraged` and `utilized`; a longer word or a hyphenated
name that merely contains one is left alone.

The signs below came later. Each states a sentence's point directly or marks
a habit that models repeat.

- **"not X but Y" contrast.** A negated article phrase, then `but` and another
  article phrase, as in `this is not a bug but a feature`. Strong, because the
  sentence only exists to knock the first half down.
- **One-line closer.** A last sentence that signs off, such as `that's it`,
  `simple as that` or `no magic`. Strong when it ends a line.
- **"X, not Y" contrast.** A copula, an article and a noun phrase followed by
  `, not a …`, `—not a …` or `-- not a …`, as in
  `this is a library, not a framework`. A correction whose second half is a data
  type or an interface word, as in `the default is a number, not a string`, does
  not match. Neither does one with no article before the noun, as in
  `pass the id, not the name`. It is a weak sign that counts from two
  occurrences, because one such sentence is often a fair statement of scope.
- **Invented hyphenated label.** A hyphenated pair in front of a generic head
  noun (`checks`, `layout`, `gate`, `pass`, `flow`, `handoff` and a few more), as in
  `stale-branch checks`. Common compounds (`read-only`, `built-in`, `open-source`),
  prefixed words (`non-`, `multi-`, `self-`) and anything in code are excluded,
  and it counts from two occurrences. A regular expression cannot tell an
  invented label from an ordinary one, so this sign is low severity and only
  adds weight to a report that other signs already justify.
- **Dash asides by another name.** A double hyphen between words (`a -- b` or
  `a--b`) counts with the em dash under the same thresholds. A parenthetical
  of two to eight lowercase words in the middle of a sentence is a finding only
  when the text carries three of them, so one aside is never flagged. Asides that
  start with `e.g.`, `see`, `for` or `or`, digits, and function calls are left alone.
- **Forced group of three.** Three stock qualities in a row, as in
  `fast, simple, and reliable`, or three repeated negations, as in
  `no config, no daemon, no setup`. Weak.
- **One subject renamed each time.** Three sentences in one paragraph that open
  with `the tool`, `the utility` and `the solution`, or another group of names for
  one thing. Weak. Repeating one name is fine.
- **Sentences that fit any project.** Stock lines such as `feel free to`,
  `a wide range of` and `designed with … in mind`. Weak and heuristic: a sentence
  that names this project's own commands and numbers does not match.
- **A longer verb for "is".** The phrases `serves as` and `stands as`, with their
  plural forms, where `is` says the same thing. Medium.

The dash threshold follows deslop-text's figures for internal documents: one in
a title is fine and two in a paragraph are a finding.

Fenced code, inline code, URLs, HTML comments, pipe-table rows and frontmatter
are skipped. Runs of `Do not …` instructions are not treated as punchy prose.
Punctuation remains a weak heuristic: technical docs can still trip medium/low
signs, which need TypeSafe confirmation before a note is shown.

The signs that need judgment (habitual passive voice, a point restated in
three sections, a product given human intent) have no regular expression. The
second TypeSafe request reads the whole rewrite and covers some of that ground.

## Limits

- Prose files only: `.md`, `.mdx`, `.markdown`, `.txt`, `.rst`, `.adoc`.
  Comments in code and the agent's chat messages are left alone.
- Edits made through `bash` (a heredoc, `sed`) are not seen.
- For `write`, the whole new content counts as added, because the tool result
  does not carry the previous file. Existing patterns may therefore be flagged
  again; this intentionally does not snapshot files before writes.
- Multiple replacements in one edit are compared together. Moving a pattern
  between replacements, or swapping phrases with the same pattern id (for
  example `utilize` for `it's worth noting`), may cancel out and go unreported.
- Without TypeSafe the pattern check still runs, but only a high-severity sign
  is reported, and the note says it is unverified.
- Jev's answers are probabilities. A dismissed finding can be real slop and a
  confirmed one can be a sentence you like. The note tells the agent it is
  advice and to keep a sentence that is already clear.

## Configuration

| Variable | Effect |
| --- | --- |
| `PI_DESLOP=0` | Turn the extension off. |
| `PI_DESLOP_VERIFY=0` | Keep the pattern check and send nothing to TypeSafe. |
| `TYPESAFE_API_KEY` | Key for the TypeSafe requests. Lookup order and other settings are in [pi-typesafe](../typesafe/README.md#configuration). |

Verification sends the added text (up to 6000 characters, dropping a partial
last word so a cut credential cannot evade redaction), the file path and
the flagged excerpts to TypeSafe. Credentials are redacted first, as for every
TypeSafe request in this collection. Each request has a four-second deadline,
and a failure or timeout falls back to the pattern check.
