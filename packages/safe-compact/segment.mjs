// segment.mjs — turn pi messages into scoreable segments and line windows.
//
// Pure and deterministic: no model calls. Everything Jev later selects is a
// span produced here, so a selection can never invent a path or a line.

const CHARS_PER_TOKEN = 4;

export function estimateTokens(text) {
  return Math.ceil(String(text ?? "").length / CHARS_PER_TOKEN);
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
      offset: Number.isInteger(args.offset) && args.offset > 0 ? args.offset : 1,
      isError: message.isError === true,
    });
  }
  return segments;
}

/** Head-and-tail excerpt: the start says what it is, the end says how it ended. */
export function excerpt(text, max) {
  if (text.length <= max) return text;
  const head = Math.ceil(max * 0.65);
  const tail = max - head;
  return `${text.slice(0, head).trimEnd()} … ${text.slice(text.length - tail).trimStart()}`;
}

/** Sentence and line candidates for span selection. */
export function splitSpans(text, { min = 20, max = 40 } = {}) {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((span) => span.trim())
    .filter((span) => span.length >= min)
    .slice(0, max);
}

/** Fixed-size line windows with 1-based inclusive bounds; coarsened to fit `maxWindows`. */
export function splitWindows(text, { size = 25, maxWindows = 40 } = {}) {
  const lines = text.split("\n");
  const step = Math.max(size, Math.ceil(lines.length / maxWindows));
  const windows = [];
  for (let start = 0; start < lines.length; start += step) {
    const slice = lines.slice(start, start + step);
    windows.push({ start: start + 1, end: start + slice.length, text: slice.join("\n") });
  }
  return windows;
}
