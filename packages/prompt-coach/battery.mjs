// battery.mjs — the small TypeSafe check that protects an on-demand rewrite.

export function buildQuestions() {
  return {
    intent_preserved: {
      type: "noul",
      instructions:
        "Does `rewritten_prompt` preserve the user's objective, scope, constraints, and requested " +
        "deliverable from `original_prompt`? Answer no if it adds requirements, changes the target, " +
        "invents repository facts, or omits important intent. A clearer structure is not drift.",
      criteria: {
        true: "The rewrite asks for the same work with the same scope and constraints, only clearer.",
        false: "The rewrite changes, adds, omits, or invents something material.",
      },
    },
  };
}
