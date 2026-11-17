// format.mjs — render fetch outcomes into the text the model receives.
// Pure and unit-testable; index.ts only wires it to the tool execution.

import { sliceText } from "./extract.mjs";

const FORMAT_LABELS = new Set(["markdown", "html", "text", "json", "raw"]);

export function isKnownFormat(value) {
  return FORMAT_LABELS.has(value);
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

export function formatWebFetchResult(outcome, { format = "markdown", maxChars, offset = 0 } = {}) {
  switch (outcome.kind) {
    case "binary":
      return formatBinary(outcome);
    case "text":
      return formatTextPayload(outcome, format, maxChars, offset);
    case "raw":
      return formatCappedText(outcome.text, maxChars ?? 200000, offset);
    case "page":
      return formatPage(outcome, format, maxChars, offset);
    default:
      return "Unknown fetch result.";
  }
}

function cutNote(window, label = "content") {
  if (!window.truncated) return "";
  return `\n\n[${label} truncated at ${window.end} of ${window.total} chars — use offset=${window.end} to continue]`;
}

function formatCappedText(text, maxChars, offset) {
  const window = sliceText(text, maxChars, offset);
  return `${window.text}${cutNote(window)}`;
}

function formatPage(outcome, format, maxChars, offset) {
  const header = metadataHeader(outcome);
  const budget = maxChars ?? 60000;

  if (format === "json") {
    const window = sliceText(outcome.markdown ?? "", budget, offset);
    return JSON.stringify(
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
        content: window.text,
        truncated: window.truncated,
        offset: window.start,
        totalChars: window.total,
        ...(window.truncated ? { nextOffset: window.end } : {}),
      },
      null,
      2,
    );
  }

  let body;
  if (format === "html") body = outcome.html || outcome.markdown;
  else if (format === "text") body = outcome.text;
  else body = outcome.markdown;

  const window = sliceText(body ?? "", budget, offset);
  const head = header.length ? header.join("\n") : "";
  return `${head}${head ? "\n\n" : ""}${window.text}${cutNote(window)}`;
}

function formatTextPayload(outcome, format, maxChars, offset) {
  const header = metadataHeader(outcome);
  const budget = maxChars ?? 60000;
  const head = header.length ? header.join("\n") : "";

  if (format === "json") {
    let source = outcome.text ?? "";
    try {
      source = JSON.stringify(JSON.parse(source), null, 2);
    } catch {
      // keep the original text when it is not JSON
    }
    const window = sliceText(source, budget, offset);
    return `${head}${head ? "\n\n" : ""}${window.text}${cutNote(window)}`;
  }

  const window = sliceText(outcome.text ?? "", budget, offset);
  let body = window.text;
  if (format === "markdown" && !isPlainTextMime(outcome.mime)) {
    const fence = body.includes("```") ? "~~~~" : "```";
    body = `${fence}\n${body}\n${fence}`;
  }
  return `${head}${head ? "\n\n" : ""}${body}${cutNote(window)}`;
}

function isPlainTextMime(mime) {
  return /^text\/(plain|markdown|x-markdown|html|xhtml)/.test(mime ?? "");
}

function formatBinary(outcome) {
  let size = "unknown size";
  if (outcome.sizeHint != null) size = `${outcome.sizeHint} bytes`;
  else if (outcome.probedBytes != null) size = `≥ ${outcome.probedBytes} bytes`;
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
    let status = "OK";
    if (item.error) status = "FAILED";
    else if (item.skipped) status = "SKIPPED";
    lines.push(`--- [${item.index + 1}/${total}] ${status} ${item.request.url}`);
    if (item.error) {
      lines.push(item.error);
    } else if (item.skipped) {
      lines.push(`Skipped: ${item.skipped}`);
    } else {
      lines.push(
        formatWebFetchResult(item.outcome, {
          format: item.request.format ?? "markdown",
          maxChars: item.cap ?? item.request.maxChars,
          offset: item.request.offset ?? 0,
        }),
      );
    }
  }
  return lines.join("\n");
}
