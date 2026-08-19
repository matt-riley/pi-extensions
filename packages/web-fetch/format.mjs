// format.mjs — render fetch outcomes into the text the model receives.
// Pure and unit-testable; index.ts only wires it to the tool execution.

import { truncateText } from "./extract.mjs";

const FORMAT_LABELS = ["markdown", "html", "text", "json", "raw"];

export function isKnownFormat(value) {
  return FORMAT_LABELS.includes(value);
}

function metadataHeader(outcome) {
  const lines = [];
  if (outcome.title) lines.push(`title: ${outcome.title}`);
  if (outcome.finalUrl) lines.push(`url: ${outcome.finalUrl}`);
  if (outcome.published) lines.push(`published: ${outcome.published}`);
  if (outcome.author) lines.push(`author: ${outcome.author}`);
  if (outcome.siteName) lines.push(`site: ${outcome.siteName}`);
  if (outcome.lang) lines.push(`lang: ${outcome.lang}`);
  if (outcome.status && outcome.status !== 200) lines.push(`status: HTTP ${outcome.status}`);
  if (outcome.via) lines.push(`via: ${outcome.via}`);
  return lines;
}

export function formatWebFetchResult(outcome, { format = "markdown", maxChars } = {}) {
  switch (outcome.kind) {
    case "binary":
      return formatBinary(outcome);
    case "text":
      return formatTextPayload(outcome, format);
    case "raw":
      return outcome.truncated
        ? `${outcome.text}\n\n[truncated at ${maxChars ?? 200000} chars — raise maxChars for more]`
        : outcome.text;
    case "page":
      return formatPage(outcome, format, maxChars);
    default:
      return "Unknown fetch result.";
  }
}

function formatPage(outcome, format, maxChars) {
  const header = metadataHeader(outcome);

  if (format === "json") {
    const json = JSON.stringify(
      {
        url: outcome.finalUrl,
        title: outcome.title,
        description: outcome.description,
        author: outcome.author,
        siteName: outcome.siteName,
        published: outcome.published,
        lang: outcome.lang,
        canonical: outcome.canonical,
        via: outcome.via,
        content: outcome.markdown,
        truncated: outcome.truncated,
      },
      null,
      2,
    );
    const capped = truncateText(json, maxChars ?? 60000);
    return capped.text;
  }

  let body;
  if (format === "html") body = outcome.html || outcome.markdown;
  else if (format === "text") body = outcome.text;
  else body = outcome.markdown;

  const head = header.length ? header.join("\n") : "";
  const truncatedNote = outcome.truncated
    ? `\n\n[content truncated at ${maxChars ?? 60000} chars — raise maxChars for more]`
    : "";
  return `${head}${head ? "\n\n" : ""}${body}${truncatedNote}`;
}

function formatTextPayload(outcome, format) {
  const header = metadataHeader(outcome);

  if (format === "json") {
    try {
      const parsed = JSON.parse(outcome.text);
      return `${header.join("\n")}${header.length ? "\n\n" : ""}${JSON.stringify(parsed, null, 2)}`;
    } catch {
      return `${header.join("\n")}${header.length ? "\n\n" : ""}${outcome.text}`;
    }
  }

  let body = outcome.text;
  if (format === "markdown" && !isPlainTextMime(outcome.mime)) {
    const fence = outcome.text.includes("```") ? "~~~~" : "```";
    body = `${fence}\n${outcome.text}\n${fence}`;
  }
  return `${header.join("\n")}${header.length ? "\n\n" : ""}${body}${outcome.truncated ? "\n\n[truncated]" : ""}`;
}

function isPlainTextMime(mime) {
  return /^text\/(plain|markdown|x-markdown|html|xhtml)/.test(mime ?? "");
}

function formatBinary(outcome) {
  const size = outcome.sizeHint != null
    ? `${outcome.sizeHint} bytes`
    : outcome.probedBytes != null
      ? `≥ ${outcome.probedBytes} bytes`
      : "unknown size";
  const lines = [
    `Binary payload — not extracted (${outcome.mime || "unknown content-type"}, ${size}).`,
    `URL: ${outcome.finalUrl ?? ""}`,
    "",
    "web_fetch extracts readable text; it does not download files. If a text/JSON",
    "representation is available for this URL (e.g. GitHub raw, an API endpoint, or a",
    "document converter), fetch that instead.",
  ];
  return lines.join("\n");
}

// --- batch ------------------------------------------------------------------

export function formatBatchResult(items, { concurrency } = {}) {
  const total = items.length;
  const ok = items.filter((i) => !i.error && !i.skipped).length;
  const skipped = items.filter((i) => i.skipped).length;
  const failed = total - ok - skipped;
  const summary = [`${ok} ok`, `${failed} failed`];
  if (skipped) summary.push(`${skipped} skipped`);
  const lines = [
    `batch_web_fetch: ${total} URLs — ${summary.join(", ")}${concurrency ? ` (concurrency ${concurrency})` : ""}`,
  ];
  for (const item of items) {
    lines.push("");
    const status = item.error ? "FAILED" : item.skipped ? "SKIPPED" : "OK";
    lines.push(`--- [${item.index + 1}/${total}] ${status} ${item.request.url}`);
    if (item.error) {
      lines.push(item.error);
    } else if (item.skipped) {
      lines.push(`Skipped: ${item.skipped}`);
    } else {
      lines.push(formatWebFetchResult(item.outcome, {
        format: item.request.format ?? "markdown",
        maxChars: item.cap ?? item.request.maxChars,
      }));
    }
  }
  return lines.join("\n");
}
