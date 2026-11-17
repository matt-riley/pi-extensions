## Playbook: hill climb

Copy these steps into your todo list before task-specific items; a step you skip stays with `skip: <reason>`.

1. Name the metric, its direction, the command that prints it and the stop condition (target, attempt cap or plateau) before the first change.
2. Run `/climb` with that command when it is available; otherwise keep the same loop by hand with `measure_command`.
3. Each attempt is one change and one measurement on the same command. Keep it only if the number moved past the noise; revert it otherwise.
4. Log every attempt in one line: what changed, the number, kept or reverted. A reverted attempt stays in the log.
5. Two flat attempts in a row mean the hypothesis is wrong: profile again or change approach instead of tuning the same knob.
6. Report the start and end numbers, attempts kept and reverted, and why you stopped.
