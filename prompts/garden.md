---
description: Queue agent shortcuts as environment fixes instead of patching one-offs
argument-hint: "[path or git ref]"
---

Act like a quality supervisor: sample the code, do not review all of it, and improve the environment rather than a single output.

1. Scope: $ARGUMENTS if given (a path or git ref), otherwise `git diff HEAD~10 --name-only` plus the uncommitted diff. List the files in scope.
2. Read those files looking for agent shortcuts: tautological tests that assert the implementation back to itself, swallowed errors, copy-paste with small edits, dead code, `any`/unsafe casts, lint suppressions with no reason, stale comments, magic numbers, and feature logic dumped into a shared god file.
3. Read `.pi/garden.md` if it exists. Keep one entry per pattern, with status (`queued`, `applied`, or `retired`), distinct evidence, proposed prevention, and any applied prevention/date. Identify code evidence by repository-relative path, symbol or short snippet, and the introducing commit when known; line numbers alone are not identity. Repeated scans, moved lines, and unchanged code are the same occurrence and do not increase the count. Session evidence uses its source file and message ID or line.
4. Append new evidence under the existing pattern, or create an entry under `## YYYY-MM-DD`: why it matters, distinct occurrence count, evidence pointers, and the cheapest preventive change (lint rule, type constraint, test, AGENTS.md line, or guardrail policy). Retain the evidence so counts can be audited.
5. Do not fix findings during this scan. At 3 distinct occurrences, draft the exact preventive change and ask for approval. Do not repeatedly propose an already applied prevention.
6. After an approved prevention is implemented, record its actual path/commit, date, and validation evidence and mark it `applied`. On later scans, record the scope/date checked and whether there is new evidence after application. Old unfixed examples are not recurrences. A new recurrence reopens the entry for diagnosis; propose repairing, replacing, or retiring ineffective guidance instead of duplicating it. A scan with no recurrence is limited evidence, not proof the problem is solved.
7. Report new evidence, changed counts, recurrence findings, and the top prevention candidate. Offer to add `.pi/garden.md` to `.gitignore` if I want the queue to stay local.
