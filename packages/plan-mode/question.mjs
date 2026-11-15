// question.mjs — the words around plan_mode_question that are not plan-only.
//
// The tool works in and out of plan mode (its execute never reads the mode), but
// it is deferred and used to be described only inside the plan-mode prompt, so
// during implementation the agent had no reason to look for it. Outside plan
// mode this short section names it and says how to load it.

export const QUESTION_LABEL = "Ask User Question";

export const QUESTION_DESCRIPTION =
  "Ask the user a decision question with 2-4 meaningful options, in plan mode and while implementing. " +
  "Include a recommended answer when you have a sensible default. " +
  "Use only for preferences, tradeoffs, or assumption locks that cannot be discovered by read-only exploration.";

export const ASK_USER_PROMPT = `# Asking the user

When a decision is the user's to make (a preference, a tradeoff, an assumption you cannot check) and exploring the repository cannot settle it, ask with plan_mode_question: a question, 2-4 options, and your recommended answer. If the tool is not listed, load it with tool search. Never ask for what you can discover by reading or searching. A question the context already settles may be answered from context by a judge; the result says so, and you should state that assumption.`;

/** The one prompt section to add: the plan prompt in plan mode, the short ask section outside. */
export function promptSection(enabled, planPrompt) {
  return enabled ? ["plan_mode", planPrompt] : ["ask_user", ASK_USER_PROMPT];
}
