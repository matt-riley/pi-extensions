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

// An approval ask is the whole plan up for sign-off, or permission to begin
// implementing with nothing else to choose. The "begin" verbs only count when
// the sentence ends there: "Should I start with the API or the UI?" is a
// decision, "Should I start?" is not.
const END = String.raw`(?=\s*(?:[?.!,;:]|$))`;
const BEGIN = String.raw`(?:go ahead|get going|get started|proceed|start|begin|implement|build)`;
const OBJECT = String.raw`(?:\s+(?:it|this|that|now|here|the plan|this plan|my plan|implementing|implementation|building|and (?:start|begin|get started)(?: implementing| building)?|with (?:it|this|that|the plan|this plan|my plan|implementation)))*`;

const APPROVAL_ASKS = [
  /\b(?:is|does|do) (?:this|the|that|my) plan (?:ok|okay|good|fine|acceptable|alright|work|look|sound|seem)\b/i,
  /\bhow (?:does|do) (?:this|the|that|my) plan (?:look|sound|seem)\b/i,
  new RegExp(String.raw`\b(?:should|shall|can|may) i ${BEGIN}${OBJECT}${END}`, "i"),
  new RegExp(String.raw`\b(?:want|like) me to ${BEGIN}${OBJECT}${END}`, "i"),
  new RegExp(
    String.raw`\b(?:happy|ok|okay|good|fine|clear) (?:for me )?to ${BEGIN}${OBJECT}${END}`,
    "i",
  ),
  new RegExp(String.raw`\bready (?:to|for(?: me to)?) ${BEGIN}${OBJECT}${END}`, "i"),
  /\b(?:any|anything)\b[^.?!\n]*\bbefore (?:we|i) (?:start|begin|proceed|implement|go)\b/i,
  /\bkick (?:this|it) off\b/i,
  new RegExp(
    String.raw`\bdo you approve(?: of)?(?: (?:this|the|my|that)(?: plan| approach)?)?${END}`,
    "i",
  ),
  /\bapprove (?:this|the|my) plan\b/i,
  /\b(?:looks good|lgtm)\b[^.\n]*\b(?:proceed|go ahead|start)\b/i,
];

/**
 * Why a question may not be asked in plan mode, or null. Asking the user to
 * approve the plan is the job of plan_mode_complete, which puts the plan in
 * front of them; a question dialog for it is a second, unrecorded route to the
 * same approval. Decisions still go through plan_mode_question.
 */
export function approvalQuestionProblem({ title, question, options } = {}) {
  const parts = [title, question, ...(Array.isArray(options) ? options : [])].filter(
    (part) => typeof part === "string",
  );
  // Each part alone: a question's words and an option's words must not combine into an ask.
  if (!parts.some((part) => APPROVAL_ASKS.some((pattern) => pattern.test(part)))) return null;
  return (
    "Rejected: do not ask for approval of the plan with a question. plan_mode_question is for decisions. " +
    "When the plan is decision-complete, call plan_mode_complete alone: it puts the plan in front of the user, " +
    "who approves it with /plan approve."
  );
}
