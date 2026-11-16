/** Extract the text represented by a message content value, joining text blocks with `separator`. */
export function messageText(content, separator = " ") {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join(separator);
}
