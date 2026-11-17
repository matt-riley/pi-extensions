## Playbook: blinded prompt eval

Copy these steps into your todo list before task-specific items; a step you skip stays with `skip: <reason>`.

1. Write down the decision the eval settles and its budget, then freeze both variants and the cases before any run.
2. No eval, test, judge, rubric, score, candidate or benchmark in any path or prompt the model under eval sees; fixtures get project-shaped names.
3. Each case prompt is what a user would type. It never asks which skills were used.
4. Run `node scripts/workflow-eval.mjs --live --variant-a <dir> --variant-b <dir> --cases <dir> --output <new dir>` inside its run and cost caps.
5. Grade chain-following from the transcript (which files were opened), not the model's own account. The judge sees outputs by label and scores both in one pass on one scale.
6. Report per case, then overall, naming the transcripts. No rerun to make the result look better.
