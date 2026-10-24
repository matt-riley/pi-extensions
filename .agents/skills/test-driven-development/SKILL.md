---
name: test-driven-development
description: Write behavior-focused tests, regression tests for bugs, or implement a feature in tested vertical slices. Use for test-driven development and test quality; cover observable behavior, failures and edge cases without coupling tests to implementation details.
---

# Behavior-driven testing

Use the repository's framework, conventions and existing test seams. Test the contract that callers rely on, not the current arrangement of private functions.

1. Read the requirement, affected callers and existing tests. Choose a small observable behavior and derive the expected result from the requirement or an independent example, not by running or copying the implementation.
2. For a bug or new behavior, write one focused test before changing production code. Run it and confirm it fails for the intended missing behavior, not a syntax error, bad fixture or missing dependency. If the reported bug cannot be reproduced at this seam, find the real seam before fixing it.
3. Make the smallest change that passes that test. Complete one tested vertical slice at a time rather than writing a speculative batch of tests and a separate implementation batch.
4. Refactor while green when it makes the code simpler. Preserve the behavior and rerun the focused test after each meaningful change. Routine names and internal structure do not need user approval; product ambiguity and compatibility changes do.
5. Cover relevant boundaries and failure paths: empty input, invalid input, exact limits, cancellation, timeouts, retries, partial failures and cleanup. Pick cases justified by this code, not a universal checklist.
6. Run the focused tests and the repository's required checks on the final diff. Report commands, observed results and anything unverified.

When adding tests for behavior that already works, start from the passing baseline. Demonstrate sensitivity to a plausible defect with an isolated fixture or a safe reversible mutation when practical; do not manufacture an irrelevant failure just to perform a red/green ritual.

## Test quality

- Exercise a public interface or stable boundary. Do not export private helpers merely to test them.
- Prefer real local collaborators. Stub clocks, randomness, network or other nondeterministic boundaries; do not mock the behavior being tested. Avoid paid or live services by default.
- Use independent expected values and assertions on meaningful effects. A test that calculates its expectation with the same algorithm can share the same bug.
- Assert item counts before comparisons, including zero-item cases when valid. A parser or parity check that compares nothing is not evidence of correctness.
- Keep fixtures small and deterministic. Assert errors and cleanup as well as successful output when those are part of the contract.
- Do not weaken assertions, delete regressions or change expected results merely to make the implementation pass.

If no runnable test seam or required runtime is available, report the concrete gap and the narrower evidence you could obtain. Do not call inspection alone a passing test.
