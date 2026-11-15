// provenance.mjs — where did this command come from?
//
// Only the person at the keyboard can authorise a risky step. Text that arrived
// as tool output (a fetched page, a file, a search hit) is evidence about the
// task, never permission, however firmly it is worded. So when a call that
// already needs a decision is a copy of something the agent read this turn, and
// the user never typed it or pointed at its source, the dialog says so and the
// call is not waved through.
//
// This is a text match, not a taint tracker: it catches the plain copy, not a
// paraphrase. Pure functions over a session branch; the entry point decides
// what to do with the answer.

const MAX_COMMAND_CHARS = 2000;
const MIN_COMMAND_CHARS = 10;
const MAX_AGREEMENT_CHARS = 40;

const AGREEMENT =
  /^(?:(?:y|yes|yep|yeah|yup|ok|okay|sure|go ahead|do it|proceed|continue|please do|sounds good|approved?|lgtm)[\s,.!]*)+$/i;

/** A reply that only says yes. It approves what was proposed, not a new step. */
export function isAgreement(text) {
  const trimmed = String(text ?? "").trim();
  return trimmed.length > 0 && trimmed.length <= MAX_AGREEMENT_CHARS && AGREEMENT.test(trimmed);
}

function messageOf(entry) {
  return entry?.message ?? entry;
}

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

const squash = (text) =>
  String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();

/** The last user message that asks for something, skipping bare agreements. */
export function humanRequest(branch, maxChars = 600) {
  if (!Array.isArray(branch)) return null;
  for (let i = branch.length - 1; i >= 0; i--) {
    const message = messageOf(branch[i]);
    if (message?.role !== "user") continue;
    const text = textOf(message.content).trim();
    if (text && !isAgreement(text)) return text.slice(0, maxChars);
  }
  return null;
}

/** What a tool call was pointed at, for naming and for "did the user mention it". */
function callTarget(args) {
  for (const key of ["path", "file_path", "url", "query", "pattern"]) {
    if (typeof args?.[key] === "string" && args[key]) return args[key];
  }
  return null;
}

function userPointedAt(userText, target) {
  if (!target) return false;
  const name =
    target
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || target;
  // A bare word like "fix" would match any sentence; a file name needs a dot or some length.
  const distinctive = name.includes(".") || name.length >= 8;
  return userText.includes(target) || (distinctive && userText.includes(name));
}

/**
 * Tool results since the last user message that contain `command` whole, named
 * like "read README.md". Empty when the user typed the command themselves, or
 * pointed at the source of the text. Failed calls are skipped: an error that
 * echoes a command is not an instruction.
 */
export function quotedFromOutput(branch, command) {
  const wanted = squash(command).slice(0, MAX_COMMAND_CHARS);
  if (!Array.isArray(branch) || wanted.length < MIN_COMMAND_CHARS) return [];

  const messages = branch.map(messageOf);
  const userText = squash(
    messages
      .filter((message) => message?.role === "user")
      .map((message) => textOf(message.content))
      .join("\n"),
  );
  if (userText.includes(wanted)) return [];

  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      start = i + 1;
      break;
    }
  }

  const targets = new Map();
  for (const message of messages) {
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block?.type === "toolCall") targets.set(block.id, callTarget(block.arguments));
    }
  }

  const sources = [];
  for (const message of messages.slice(start)) {
    if (message?.role !== "toolResult" || message.isError === true) continue;
    if (!squash(textOf(message.content)).includes(wanted)) continue;
    const target = targets.get(message.toolCallId) ?? null;
    if (userPointedAt(userText, target)) continue;
    const label = [message.toolName ?? "tool", target].filter(Boolean).join(" ");
    if (!sources.includes(label)) sources.push(label);
  }
  return sources;
}
