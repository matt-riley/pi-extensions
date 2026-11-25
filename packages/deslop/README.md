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
(cited as `deslop rule N`). A later pass also used the pattern categories in
[petergyang/no-ai-slop](https://github.com/petergyang/no-ai-slop) (MIT). That
source was used for ideas only: none of its wording, examples or code is copied
here. The detector phrase lists are written for this collection, as is the
extension logic and advice. Only the signs a regular expression can decide are
checked here:

| Severity | Signs |
| --- | --- |
| High (strong) | Filler phrases (W1), "not X, it is Y" and "not X but Y" contrasts (W2), marketing adjectives (W5), generic openings (W6), paired adjectives (W9), "excited to announce" (W15), "whether you're X or Y" (W16), throat-clearing pivots (W17), corporate and internet cliches (W21, W25, W36), runs of short punchy sentences (W34), one-line closers such as "that's it", parenthetical asides repeated three times, faux-insight setups, dramatic fragments, rhetorical setups, chat replies left in the document |
| Medium (weak) | Dash asides, em dash or double hyphen (W3), self-posed rhetorical questions (W4), stacked hedging (W8), text narrating its own structure (W10), mechanical transitions (W11), exclamation clusters (W18), emoji as emphasis or in headings (W23, W30), sincerity intensifiers (W38), "serves as" for "is" (deslop rule 3), "X, not Y" contrasts (contrastive framing), one subject renamed with a new synonym each time, colon reveals, superficial -ing analysis, importance puffery, weasel attribution, interpretive metadiscourse, negative listing, puffed-up verbs |
| Low (weak) | "very" (W20), curly quotes (W27), "quietly" (W45), unicode arrows (deslop rule 9), invented hyphenated labels, forced groups of three, sentences that fit any project's docs, wordy phrases |

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
  `simple as that` or `no magic`. Strong when it ends a line with a full stop or an exclamation mark.
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
- **Faux-insight setup.** A line that casts the writer as the only one in on
  a secret, such as `what nobody tells you` or `what everyone misses`.
  Strong. State the claim and drop the setup.
- **Colon reveal.** A hype lead-in, a colon, then a lowercase punchline, as in
  `The best part: the cache warms itself`. Weak. Ordinary labels (`Timeout: 15`),
  headings, lists and code are left alone.
- **Superficial -ing analysis.** A trailing `-ing` clause that pretends to
  explain meaning, as in `highlighting the team's commitment to faster runs`.
  Weak. "Highlighting" a log line does not match.
- **Importance puffery.** Stock gravity, such as `a testament to` or
  `pivotal moment`. Weak. State the fact and leave the judgment to the reader.
- **Weasel attribution.** A nameless authority, such as `studies show` or
  `experts agree`. Weak. Name the source or cut the claim.
- **Dramatic fragment.** The two-beat sign-off `That's it. That's the whole thing.`
  Strong. Use one complete sentence. The existing one-line closer still covers
  a last-line `that's it` on its own.
- **Rhetorical setup.** Openers such as `picture this:` or `ask yourself:`
  that hold back the claim. Strong.
- **Interpretive metadiscourse.** An aside that tells the reader how to take
  the sentence, such as `put simply` or `to put it another way`. Weak.
- **Negative listing.** Two `Not a …` sentences in a row before saying what
  the thing is. Weak. State what it is and drop the list.
- **Chat reply left in the document.** Lines that answer or sign off to a
  reader as if in a chat, such as `I hope this helps`, `great question`,
  `happy coding`, `stay tuned`, or a sentence opening with `Certainly!`. Strong.
- **Puffed-up verb.** `empowers`, `streamlines`, `fosters`, `boasts` and
  `revolutionizes`, where a plain verb says what happens. Medium.
- **Wordy phrase.** `in order to`, `due to the fact that`, `in the event that`
  and similar, where a short form exists. Low.

Later additions to existing signs: the `not just X, it's Y` contrast also
matches across a dash or a colon, and `not only does it X, it also Y` counts.
Filler covers `it is important to note`, `plays a crucial role` and
`a myriad of`; marketing covers `state-of-the-art` and `harness the power of`;
pivots cover `let's dive into`, `let me explain` and `this is where X comes in`.
`Ultimately`, `Notably` and `Importantly` count as mechanical transitions, and
`Bottom line:` or `Spoiler:` before a lowercase punchline as a colon reveal.

The dash threshold follows deslop-text's figures for internal documents: one in
a title is fine and two in a paragraph are a finding.

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
`./code`. The pass runs two lists over the same diff: the code habits below, and
the [lowered bar checks](#lowered-bar-checks) that follow them.

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
| Type escape hatch used to quiet the compiler | `as any`, `<any>` and `as unknown as T`, in TypeScript files. A `@ts-ignore` or `@ts-expect-error` comment is a suppression, which the [lowered-bar](#lowered-bar-checks) pass reports. |
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

### Lowered bar checks

A branch can go green by making green easier to reach: silence the check, skip
the test, lower the threshold, leave the stub, sleep until a race usually
passes, retry the flake, or raise the timeout. The other checks here judge how
code is written. These judge what the diff does to the bar the code has to clear.
They run inside `/deslop code`, on the same diff and the same read-only git
calls, because that command already knows which lines a branch added and removed.
[done-gate](../done-gate/README.md) is the other candidate: it decides at the end
of a turn whether the agent ran its checks, from edits it saw, and it neither reads
a branch diff nor looks at config or workflow files. The checks live in
`lowered.mjs`; findings are labelled `lowered-bar`.

Only a change counts: an added line, a removed line, a deleted file. A
suppression that was already in the file is not new. Each finding names
`path:line` and a short excerpt, and ends with what to do. Nothing is rewritten.

| Finding | Strong when the diff |
| --- | --- |
| New suppression of a lint, type or coverage check | adds `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `eslint-disable`, `oxlint-disable`, `biome-ignore`, `# noqa`, `# type: ignore`, `//nolint`, `# pylint: disable`, `# pragma: no cover`, `istanbul ignore`, `c8 ignore`, `v8 ignore`, `nosemgrep`, `gitleaks:allow`, or a Rust `#[allow(...)]`. A directive counts only as a comment, so a quoted string or a sentence that mentions one is not flagged. |
| Test skipped, deleted or stripped of assertions | adds `.skip` or `.only`, `xit`, `xdescribe`, `t.Skip`, `#[ignore]`, a pytest or unittest skip, or a node test `skip` option; deletes a test file while the file it tests stays; or removes more assertions than it adds across the test files that remain. |
| Threshold lowered, CI check removed or lint rule switched off | lowers a coverage floor (`lines`, `branches`, `threshold`, `fail_under` and similar) or raises a budget ceiling (`maxSize`, `max-warnings` and similar) on the same key; removes a `run:` or `uses:` step or script line that runs a check (tests, lint, type-check, scan) from a workflow without adding it anywhere in the diff, or deletes such a workflow; adds `continue-on-error: true` or `|| true` to a check; or sets a rule to `off`, `0` or `allow`, starts an `ignore` list, or sets `strict` and its relatives to `false` in an ESLint, oxlint, Biome, Ruff, golangci, TypeScript or Cargo config. |
| Stub, empty error handler or TODO standing in for the code | adds a throw or panic of "not implemented", `NotImplementedError`, `todo!()` or `unimplemented!()`; adds a `catch`, `except` or `if err != nil` block with nothing in it, or `.catch(() => {})`; or adds a function whose only body is a `TODO`, `FIXME` or `XXX` comment. |
| Fixed sleep, test retry or raised test timeout | in a test file or a test runner config (`jest.config`, `vitest.config` and similar), adds a fixed-duration wait (`await sleep(1000)`, `await delay(10)`, `await new Promise((r) => setTimeout(r, n))`, `time.sleep`, `time.Sleep`, `thread::sleep`, `cy.wait(n)`, `waitForTimeout`); adds a retry (`retry: 3`, `jest.retryTimes`, `this.retries`, `pytest.mark.flaky`, `reruns=`); or sets or raises a test timeout (`timeout` or `testTimeout` on a test or runner, `jest.setTimeout`, `this.timeout`). A tighter timeout, a wait in production code, a quoted shell `sleep`, and a request timeout such as `page.goto({ timeout })` are not flagged. |

**Strong and weak.** A strong finding has severity `high`. A reason moves a hit to a
weak finding, severity `low`, which is listed under the label "weak sign" and, like
every low finding, shows only beside a stronger one. A reason is any of:

- two or more plain words in the comment on the same line, once the directive and
  rule names such as `no-console` or `E501` are set aside (a rule name is not a reason);
- a comment-only line directly above or below that has two plain words;
- for a skip call, a string argument of two plain words, as in
  `t.Skip("flaky on shared runners")` (a test name such as `it.skip("adds")` is not one);
- a commit message on the branch that is about that kind of change and says why:
  it names the change (`suppress`, `skip`, `lower`, `stub`, `sleep`, `retry`,
  `timeout` and similar) and uses a reason word (`because`, `until`, `flaky`,
  `upstream`, `workaround`, `tracked`, an issue number). A message downgrades only
  the finding category it is about. The
  messages come from one read-only `git log` of the commits since the base, and
  are fetched only when a strong finding exists.

Two cases soften a finding for other causes: a removed whole test case (as
opposed to assertions pulled out of a test that stays), and a `TODO` that cites an
issue number or URL.

**Where it can be wrong.** Everything is a pattern over lines, with no parser.
Assertion counts are by line, so a test rewritten into a different assertion
style can read as fewer assertions; counts are taken across the whole diff, so
tests moved between files cancel. A deleted test file is excused only when a deleted
source file has the same stem. A check moved into a shared workflow reads as
removed. An empty `catch` around cleanup is flagged, with a comment in the block
as the way to say it is deliberate. A bare `@ts-ignore` or empty `catch` can also
appear in the code-slop list for its own reason; the type directive is reported
only here. Only `.mjs`, `.ts`, `.py`, `.go` and `.rs` sources get the stub and
empty-handler checks, and test files, lock files, generated output and Markdown
are never read for them. A test of a timer itself can look like a fixed sleep;
a short timeout added on a test is flagged the same way as a long one, because
the diff cannot see the runner's default.

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
