// segment.mjs — turn pi messages into scoreable segments and line windows.
//
// Pure and deterministic: no model calls. Everything Jev later selects is a
// span produced here, so a selection can never invent a path or a line.

/**
 * Tokens without a tokenizer: a word costs one per six letters, a digit half,
 * any other symbol nine tenths. Measured against pi's own reported context
 * tokens over twelve real sessions, this lands a median 1.3x short of the real
 * count where the chars/4 it replaced ran 1.8x short and up to 7x on tool-heavy
 * spans. Both undercount, so what matters is the size of the error wherever an
 * estimate is held against a number pi measured in real tokens: the
 * keepRecentTokens budget, and MAX_HANDOFF_TOKENS.
 */
const TOKEN_PIECES = /[A-Za-z]+|\d+|[^\sA-Za-z\d]/g;

export function estimateTokens(text) {
  let tokens = 0;
  for (const [piece] of String(text ?? "").matchAll(TOKEN_PIECES)) {
    const first = piece.charCodeAt(0);
    if (first >= 48 && first <= 57) tokens += piece.length / 2; // 0-9
    else if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) {
      tokens += 1 + Math.floor((piece.length - 1) / 6); // A-Z / a-z
    } else {
      tokens += 0.9; // punctuation, operators, CJK
    }
  }
  return Math.ceil(tokens);
}

function blockText(block) {
  if (typeof block === "string") return block;
  if (block?.type === "text") return block.text ?? "";
  if (block?.type === "toolCall") return `${block.name}(${JSON.stringify(block.arguments ?? {})})`;
  if (block?.type === "image") return "[image]";
  return ""; // thinking and unknown blocks never reach a summary
}

export function messageText(message) {
  if (message?.role === "bashExecution") return `$ ${message.command}\n${message.output ?? ""}`;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(blockText).filter(Boolean).join("\n");
  return typeof message?.summary === "string" ? message.summary : "";
}

/**
 * One segment per non-empty message. Tool results inherit the path and read
 * offset from the tool call that produced them, so a later pointer can name a
 * real file range.
 */
export function segmentMessages(messages) {
  const calls = new Map();
  const segments = [];
  for (const message of messages) {
    if (message?.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === "toolCall") calls.set(block.id, block);
      }
    }
    const text = messageText(message).trim();
    if (!text) continue;
    const call = message.role === "toolResult" ? calls.get(message.toolCallId) : undefined;
    const args = call?.arguments ?? {};
    segments.push({
      id: `s${segments.length}`,
      role: message.role,
      text,
      tokens: estimateTokens(text),
      tool: message.toolName ?? call?.name,
      path: typeof args.path === "string" ? args.path : undefined,
      command: typeof args.command === "string" ? args.command : undefined,
      offset: Number.isInteger(args.offset) && args.offset > 0 ? args.offset : 1,
      isError: message.isError === true,
    });
  }
  return segments;
}

/** Sentence and line candidates for span selection. */
export function splitSpans(text, { min = 20, max = 40 } = {}) {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((span) => span.trim())
    .filter((span) => span.length >= min)
    .slice(0, max);
}
