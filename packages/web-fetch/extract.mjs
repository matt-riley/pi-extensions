// extract.mjs — turn a fetched response body into the requested output
// format. Pure and network-free so it is fully unit-testable; fetch.mjs
// supplies the bytes and charset-decodes them first.

import {
  buildTree,
  extractMetadata,
  selectMain,
  serializeTree,
  stripBoilerplate,
  tokenize,
} from "./html.mjs";
import { treeToMarkdown, treeToText } from "./markdown.mjs";

const MAX_RAW_CHARS = 4_000_000; // cap on the body we will process
export const DEFAULT_MAX_CHARS = 60_000;
export const RAW_DEFAULT_MAX_CHARS = 200_000;
export const THIN_CONTENT_CHARS = 250; // below this, alternates are worth trying

// --- content-type / format helpers -----------------------------------------

export function parseContentType(header = "") {
  const parts = String(header).split(";");
  const mime = (parts[0] ?? "").trim().toLowerCase();
  let charset = "";
  for (const p of parts.slice(1)) {
    const m = /^\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(p);
    if (m) charset = m[1].toLowerCase();
  }
  return { mime, charset };
}

export function isHtmlContent({ mime = "", body = "" } = {}) {
  if (mime.includes("text/html") || mime.includes("application/xhtml")) return true;
  const sniff = String(body ?? "")
    .trimStart()
    .slice(0, 512)
    .toLowerCase();
  return sniff.startsWith("<!doctype html") || sniff.startsWith("<html");
}

export function isTextMime(mime) {
  if (!mime) return false;
  return (
    mime.startsWith("text/") ||
    /json/.test(mime) ||
    /xml/.test(mime) ||
    /javascript/.test(mime) ||
    /yaml/.test(mime) ||
    /csv/.test(mime) ||
    /x-www-form-urlencoded/.test(mime) ||
    /svg/.test(mime)
  );
}

export function isBinaryMime(mime) {
  return !isTextMime(mime) && !/html|xhtml/.test(mime);
}

// A window into `text` starting at `offset`, at most `maxChars` long.
// Never cuts mid-word when a break is nearby. The returned `end` is the
// offset to pass for the next window; `truncated` means more text follows.
export function sliceText(text, maxChars, offset = 0) {
  const source = String(text ?? "");
  const total = source.length;
  const budgetRaw = Number(maxChars);
  const budget = Number.isFinite(budgetRaw) && budgetRaw > 0 ? Math.trunc(budgetRaw) : total;
  const startRaw = Number(offset);
  const start =
    Number.isFinite(startRaw) && startRaw > 0 ? Math.min(Math.trunc(startRaw), total) : 0;
  if (total - start <= budget) {
    return { text: source.slice(start), start, end: total, total, truncated: false };
  }
  let end = start + budget;
  const window = source.slice(start, end);
  const lastBreak = Math.max(window.lastIndexOf("\n"), window.lastIndexOf(" "));
  if (lastBreak > budget * 0.6) end = start + lastBreak;
  while (end > start && /\s/.test(source[end - 1])) end--;
  return { text: source.slice(start, end), start, end, total, truncated: end < total };
}

export function truncateText(text, maxChars) {
  const window = sliceText(text, maxChars, 0);
  return { text: window.text, truncated: window.truncated };
}

// --- extraction pipeline ----------------------------------------------------

// Extracts readable content from a decoded body.
// Returns:
//   html  -> { kind:"page", meta, markdown, html, text, rawTextLength, truncated }
//   text  -> { kind:"text", text, truncated }
//   binary-> { kind:"binary", size }
export function extractPage({
  contentType = "",
  body = "",
  includeImages = false,
  maxChars = DEFAULT_MAX_CHARS,
} = {}) {
  const raw = String(body ?? "").slice(0, MAX_RAW_CHARS);
  const { mime } = parseContentType(contentType);

  if (!isHtmlContent({ mime, body: raw })) {
    if (isTextMime(mime) || looksLikeJson(raw)) {
      const trimmed = raw.trim();
      return {
        kind: "text",
        text: trimmed,
        truncated: trimmed.length > maxChars,
        size: trimmed.length,
      };
    }
    return { kind: "binary", size: raw.length };
  }

  const meta = extractMetadata(raw);
  const tokens = tokenize(raw);
  const tree = buildTree(tokens);
  const cleaned = stripBoilerplate(tree);
  const main = selectMain(cleaned ?? tree);

  const markdown = treeToMarkdown(main, { includeImages });
  const html = serializeTree(main, { pretty: true });
  const text = treeToText(main);
  const rawTextLength = text.length;

  // Keep the full extracted text so a later window can be formatted with
  // offset. The output budget is applied in format.mjs, not here.
  return {
    kind: "page",
    meta,
    markdown,
    html,
    text,
    rawTextLength,
    truncated: markdown.length > maxChars || html.length > maxChars || text.length > maxChars,
  };
}

function looksLikeJson(text) {
  const t = String(text).trimStart();
  return t.startsWith("{") || t.startsWith("[");
}
