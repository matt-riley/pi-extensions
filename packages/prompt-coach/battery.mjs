// battery.mjs — the small TypeSafe check that protects an on-demand rewrite.

export function buildCoachQuestions() {
  return {
    intent_preserved: {
      type: "noul",
      instructions:
        "`rewritten_prompt` is a deeper version of `original_prompt` for a coding agent. Does it ask " +
        "for the same task, with the same goal, target, scope, and constraints? " +
        "Answer yes when it only makes the same task more thorough: it tells the agent to read " +
        "files, logs, or test output first, names methods or commands, adds care inside the same " +
        "task (such as checking callers), or ends with a check the agent can run, such as a test " +
        "or command. " +
        "Answer no when it adds a feature, deliverable, deadline, or requirement the user did not " +
        "ask for, widens or narrows the scope, changes the target, or reverses a constraint. " +
        "Answer no when it names a specific file path that appears neither in `original_prompt` " +
        "nor in `repository_probe` (including `files_read`). Suggesting commands or tests to run, " +
        "or telling the agent to find or locate something, is fine.",
      criteria: {
        true: "Same task, same scope and constraints; the rewrite is only more thorough or clearer.",
        false:
          "The rewrite changes the task, widens the scope, adds a feature, deliverable, or requirement, or names a file that was never seen.",
      },
    },
  };
}
