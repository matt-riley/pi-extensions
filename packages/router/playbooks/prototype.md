## Playbook: prototype

Copy these steps into your todo list before task-specific items; a step you skip stays with `skip: <reason>`.

1. Name the decision the prototype settles and what you would need to see to choose. No decision, no prototype.
2. Build it throwaway, outside the source tree (a scratch directory), with no tests, polish or reuse in mind.
3. Put the variants behind one switch (a flag, an env var, one argument) so each is one command away.
4. Run every variant on the same input. The observation is the test: what you saw, not what the code suggests.
5. Write the choice and the evidence in a few lines. Leave the scratch code out of the repository.
6. Hand the chosen variant to the feature playbook to build properly; do not promote prototype code as it is.
