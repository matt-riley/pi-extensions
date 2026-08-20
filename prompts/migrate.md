---
description: Apply an upgrade plan one breaking change at a time, verifying between each
argument-hint: "[report]"
---
Apply the upgrade migration from ${1:-the upgrade report earlier in this conversation}. Work one breaking change or deprecation at a time, in severity order (P0 → P1 → P2 → P3), running the repo's checks/tests after each and confirming green before starting the next. Do not batch unrelated fixes. If a fix needs a decision the report didn't settle, stop and ask before guessing. After the last change, run the report's Verification commands. Report each applied change as `path:line — what changed`.
