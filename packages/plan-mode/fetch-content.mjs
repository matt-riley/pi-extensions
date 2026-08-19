// fetch-content.mjs — turn fetched HTTP responses into compact readable text
// for plan mode's read-only web access (plan_fetch_url).
//
// Zero-dependency HTML→text: strip script/style/noscript blocks and comments,
// pull the <title>, drop the remaining tags, decode the common HTML entities
// (named + numeric), and collapse whitespace. Non-HTML payloads pass through
// verbatim (trimmed). Output is capped so one fetch can't flood the context.

const MAX_RAW_CHARS = 2_000_000; // raw-body cap read before extraction
const MAX_TEXT_CHARS = 40_000; // readable-text cap handed to the model

// Detect HTML: explicit content-type, or a document-typed body sniff (some
// servers serve HTML with a generic or missing content-type).
export function isHtml({ contentType = "", body = "" }) {
  const ct = contentType.toLowerCase();
  if (ct.includes("text/html") || ct.includes("application/xhtml")) return true;
  const sniff = String(body).trimStart().slice(0, 512).toLowerCase();
  return sniff.startsWith("<!doctype html") || sniff.startsWith("<html");
}

const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", copy: "©", reg: "®", trade: "™",
  bull: "•", middot: "·", times: "×", divide: "÷", para: "¶",
  sect: "§", deg: "°", micro: "µ", ensp: "\u2002", emsp: "\u2003",
  thinsp: "\u2009", zwnj: "\u200c", zwj: "\u200d", shy: "\u00ad",
  euro: "€", pound: "£", yen: "¥", cent: "¢", frac12: "½", frac14: "¼",
  frac34: "¾", iexcl: "¡", iquest: "¿", laquo: "«", raquo: "»",
};

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (match, entity) => {
    if (entity.startsWith("#")) {
      const hex = entity[1] === "x" || entity[1] === "X";
      const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

// Extract readable text from a fetched body.
// Returns { title, text, truncated } where title is the HTML <title> ("" for
// non-HTML) and truncated reports whether text was cut at maxChars.
export function extractReadable({ contentType = "", body = "", maxChars = MAX_TEXT_CHARS }) {
  const raw = String(body ?? "").slice(0, MAX_RAW_CHARS);
  let title = "";
  let text = raw;
  if (isHtml({ contentType, body: raw })) {
    const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch) {
      title = decodeEntities(titleMatch[1].replace(/<[^>]*>/g, ""))
        .replace(/\s+/g, " ")
        .trim();
    }
    text = raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/\u00a0/g, " ");
    text = decodeEntities(text);
  }
  text = text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const truncated = text.length > maxChars;
  if (truncated) {
    // Cut at a word boundary near the cap instead of mid-word.
    let cut = text.slice(0, maxChars);
    const lastBreak = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(" "));
    if (lastBreak > maxChars * 0.6) cut = cut.slice(0, lastBreak);
    text = `${cut.trim()}\n… [truncated]`;
  }
  return { title, text, truncated };
}
