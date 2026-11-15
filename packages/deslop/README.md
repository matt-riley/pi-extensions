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
not created. This is an editing request, not an automatic regex replacement or a
guarantee that a model preserves meaning. The usual post-edit checks still run
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
| High | Filler phrases (W1), "not X, it is Y" contrasts (W2), marketing adjectives (W5), generic openings (W6), paired adjectives (W9), "excited to announce" (W15), "whether you're X or Y" (W16), throat-clearing pivots (W17), corporate and internet cliches (W21, W25, W36), runs of short punchy sentences (W34) |
| Medium | Em dash asides (W3), self-posed rhetorical questions (W4), stacked hedging (W8), text narrating its own structure (W10), mechanical transitions (W11), exclamation clusters (W18), emoji as emphasis or in headings (W23, W30), sincerity intensifiers (W38), "serves as" for "is" (deslop rule 3) |
| Low | "very" (W20), curly quotes (W27), "quietly" (W45), unicode arrows (deslop rule 9) |

One high sign is enough for a report. Medium and low signs need company.
Curly quotes need four occurrences and arrows need two before they count.
The em dash threshold follows deslop-text's figures for internal documents:
one in a title is fine and two in a paragraph are a finding.

Fenced code, inline code, URLs, HTML comments, pipe-table rows and frontmatter
are skipped. Runs of `Do not …` instructions are not treated as punchy prose.
Punctuation remains a weak heuristic: technical docs can still trip medium/low
signs, which need TypeSafe confirmation before a note is shown.

The signs that need judgment (habitual passive voice, a point restated in
three sections, a product given human intent) have no regular expression. The
second TypeSafe request reads the whole rewrite and covers some of that ground.

## Code review pass: `/deslop code [base]`

The prose checks above read text. This command reads code, as its own pass with
its own list, and it runs only when you type it: `/deslop code` or
`/deslop code <base>`. To clean a directory that is itself called `code`, write
`./code`.

**How it picks what to read.** It finds the commit where your branch left the
base (`origin/HEAD`, then `origin/main`, `origin/master`, `main`, `master`, or
the ref you pass) and diffs the working tree against it. Only lines the branch
added are judged, with the few context lines git prints beside them so a check can
see the line above or below. Test files, build output and anything that is not
code are skipped, though tests still count when a check asks who uses a name.

**What it does with the result.** It prints a list in the same format as the prose
notes and stops there. The git calls are read-only and no file is touched, so
whether to act on a line is a decision for you or the agent after reading the
code.

| Finding | Matches |
| --- | --- |
| Failure turned into a normal-looking value | A `catch` whose whole body returns `null`, `false`, `undefined` or an empty value, an empty `catch`, `.catch(() => [])`, a Python `except` that only passes or returns nothing, a Go `if err != nil` that returns `nil`. Logging, rethrowing, a call or a comment in the body clears it. |
| Comment saying what the next line already says | A one-line comment whose content words all occur in the line below, such as `// increment the counter` over `counter += 1`. A reason word, a colon, a digit or a lint directive clears it. |
| Type escape hatch used to quiet the compiler | `as any`, `<any>`, `as unknown as T`, and a `@ts-ignore` or `@ts-expect-error` with no reason after it, in TypeScript files. |
| Default or guard for a case nobody described | A real `a ?? b ?? c` chain, or a comment that says `fallback`, `just in case`, `should never happen`, `legacy` or `backwards compatible`. Two separate `??` on one line do not count. |
| Logic buried under several levels of conditions | An `if`, `for` or `while` that sits inside three other blocks, and an `else` that follows a block which already returned, threw or continued. |
| Interface with a single implementation, or wrapper that only forwards | An interface or abstract class the diff implements once, and a function whose body only passes its own parameters, in order, to one other function. |

The last row is a low finding. A low finding is listed only when a medium one is
also present, so a diff with nothing but a forwarding wrapper reports no
proposals. Private helpers that have a single caller are ordinary code and are
not looked for at all.

**Where it can be wrong.** Every check is a pattern over text with no parser.
Nesting is read from indentation, so a hunk that begins deep inside a function
sees fewer enclosing blocks than there are. A forwarding wrapper is sometimes
the public name for an internal function. A `catch` that returns nothing is
sometimes correct, which is why the finding says to record the reason.

**Limits.** Files git does not track yet are absent from the diff. The diff is
cut at 400,000 characters, and a line over 500 characters is skipped as
minified. Wrapper detection covers JavaScript, TypeScript and Python. `PI_DESLOP=0`
turns the command off along with the rest of the extension.

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
