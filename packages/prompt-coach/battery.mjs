// battery.mjs — the small TypeSafe check that protects an on-demand rewrite.

export function buildCoachQuestions() {
  return {
    intent_preserved: {
      type: "noul",
      instructions:
        "Does `rewritten_prompt` preserve the user's objective, scope, constraints, and requested " +
        "deliverable from `original_prompt`? Answer no if it adds new features, deliverables, or " +
        "requirements, changes the target, names files, commands, or tests that are not in " +
        "`repository_probe` (including `files_read`), or omits important intent. A clearer " +
        "structure is not drift, and naming files, commands, or a check is not drift when the " +
        "task stays the same.",
      criteria: {
        true: "The rewrite asks for the same work with the same scope and constraints, only clearer.",
        false: "The rewrite changes, adds, omits, or invents something material.",
      },
    },
  };
}
