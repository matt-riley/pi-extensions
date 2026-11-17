## Playbook: pause safely

Copy these steps into your todo list before task-specific items; a step you skip stays with `skip: <reason>`.

1. Finish the current atomic step or back it out. Start nothing new.
2. Stop running children (`/subagents`) and background jobs, and say which you stopped.
3. Make one `wip:` commit only if the user has authorised commits in this session; otherwise leave the tree as it is.
4. State whether the tree is clean, which branch it is on, and what is uncommitted.
5. Run `/handoff save` with the task, decisions, changed paths, open checks and the first action on resume.
6. Report where the handoff was saved and stop.
