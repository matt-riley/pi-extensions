## Playbook: performance

Copy these steps into your todo list before task-specific items; a step you skip stays with `skip: <reason>`.

1. Write the claim you expect to make, with its unit and workload. Capture a baseline with `measure_command` before touching code.
2. Find the limiter by profiling in a run you do not report. Explain the number before you trust it: what work it counts and why it is that size.
3. Try in order and stop at the first that meets the target: don't do it, don't do it again, do it less, do it later, do it when nobody is waiting, do it concurrently, do it cheaper.
4. One change per measurement, same command, baseline and candidate interleaved. Overlapping ranges mean no measurable difference: revert.
5. Check the work happened (`expected_work`), then measure the end-to-end path the user waits on with the same command as the baseline.
6. Report verdict first (faster, slower, no measurable difference, inconclusive), then baseline, result, run count, range and limiter.
