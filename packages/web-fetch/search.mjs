// search.mjs — keyless web search via DuckDuckGo's HTML endpoint.
//
// Pure and network-free: parsing runs on raw HTML supplied by web-fetch's
// HTTP layer (browser headers, redirects, charset detection, size caps), so
// this module is fully unit-testable with node --test.
//
// The parser targets DuckDuckGo's html.duckduckgo.com markup:
//   <div class="result ...">
//     <div class="links_main links_deep result__body">
//       <h2 class="result__title"><a class="result__a" href="//duckduckgo.com/l/?uddg=...">Title</a></h2>
//       <a class="result__snippet" href="...">Snippet with <b>bold</b></a>
//     </div>
//   </div>
// Result links are wrapped in a uddg= redirect that must be decoded.

import { tokenize, VOID_TAGS } from "./html.mjs";
import { safeResolve } from "./fetch.mjs";

export const DDG_HTML_URL = "https://html.duckduckgo.com/html/";

export function buildDdgSearchUrl(query, { region = "" } = {}) {
  const url = new URL(DDG_HTML_URL);
  url.searchParams.set("q", String(query ?? "").trim());
  if (region) url.searchParams.set("kl", region);
  return url.href;
}

function tokenClass(token) {
  for (const a of token?.attrs ?? []) {
    if (a.name === "class") return a.value;
  }
  return "";
}

function tokenHasClass(token, name) {
  return tokenClass(token).split(/\s+/).includes(name);
}

// DuckDuckGo wraps organic result links as //duckduckgo.com/l/?uddg=<encoded>&rut=...
// Decode the real destination; keep plain/absolute hrefs as-is.
function decodeDdgUrl(href) {
  if (!href) return "";
  const resolved = safeResolve(href, "https://duckduckgo.com/");
  if (!resolved) return "";
  const host = resolved.hostname;
  if (host === "duckduckgo.com" || host.endsWith(".duckduckgo.com")) {
    const uddg = resolved.searchParams.get("uddg");
    if (uddg) {
      try {
        return decodeURIComponent(uddg);
      } catch {
        return "";
      }
    }
  }
  return resolved.href;
}

const MAX_FIELD_CHARS = 1000;

// Pull title/href/snippet out of one result block's token range. A mini
// open/close stack tracks nesting so text inside <b> snippet emphasis and
// the nested result__extras markup are handled correctly, and only the
// result__a / result__snippet anchors contribute text.
function extractBlock(tokens, start, end) {
  const stack = [];
  let href = "";
  let title = "";
  let snippet = "";
  let inTitle = 0;
  let inSnippet = 0;

  for (let i = start; i <= end && i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "tag") {
      if (VOID_TAGS.has(t.name)) continue;
      if (t.name === "a" && tokenHasClass(t, "result__a")) {
        inTitle++;
        if (!href) {
          for (const a of t.attrs ?? []) {
            if (a.name === "href") href = a.value;
          }
        }
      } else if (t.name === "a" && tokenHasClass(t, "result__snippet")) {
        inSnippet++;
      }
      stack.push(t.name);
    } else if (t.type === "close") {
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k] === t.name) {
          if (t.name === "a" && inTitle) inTitle--;
          else if (t.name === "a" && inSnippet) inSnippet--;
          stack.length = k;
          break;
        }
      }
    } else if (t.type === "text") {
      // Tokenizer text is already entity-decoded.
      if (inTitle && title.length < MAX_FIELD_CHARS) title += t.text;
      else if (inSnippet && snippet.length < MAX_FIELD_CHARS) snippet += t.text;
    }
  }

  const clean = (s) => s.replace(/\s+/g, " ").trim();
  return {
    title: clean(title),
    url: decodeDdgUrl(href),
    snippet: clean(snippet),
  };
}

// Parse organic results out of a raw DuckDuckGo HTML response body.
// Returns { results, blocked }:
//   results — [{ title, url, snippet }], capped at `limit`
//   blocked — always false here; use isDdgBlocked() for challenge detection
//
// Token-stream based (not buildTree): DDG's result divs nest legitimately
// (wrapper > result__body > extras > ...), and buildTree's same-name div
// guard flattens nested divs on purpose for content extraction. A dedicated
// open/close stack preserves the real nesting just long enough to capture
// each result__body block.
export function parseDdgResults(html, { limit = 5 } = {}) {
  const results = [];
  if (!html) return { results, blocked: false };

  const tokens = tokenize(String(html));

  // Pass 1: locate each div.result__body and its matching close token.
  const opens = [];
  const bodies = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "tag") {
      if (!VOID_TAGS.has(t.name)) opens.push(i);
      if (t.name === "div" && tokenHasClass(t, "result__body")) bodies.push({ start: i, end: -1 });
    } else if (t.type === "close") {
      const openIdx = opens.pop();
      if (openIdx !== undefined) {
        for (const b of bodies) {
          if (b.start === openIdx && b.end === -1) {
            b.end = i;
            break;
          }
        }
      }
    }
  }

  // Pass 2: extract fields from each captured block.
  for (const b of bodies) {
    if (results.length >= limit) break;
    const block = extractBlock(tokens, b.start, b.end === -1 ? tokens.length - 1 : b.end);
    if (!block.url || !block.title) continue;
    results.push(block);
  }

  return { results, blocked: false };
}

// DDG serves a bot-challenge page (HTTP 202, "anomaly" markers) instead of
// results when it suspects scraping. Only meaningful when zero results came
// back — a legit page with results can mention the word "anomaly".
export function isDdgBlocked({ status = 0, body = "" } = {}) {
  if (status === 202) return true;
  const head = String(body ?? "").slice(0, 200_000);
  return (
    /jschallenge/i.test(head) ||
    /anomaly\.js/.test(head) ||
    /We've detected unusual traffic/.test(head)
  );
}

// Markdown formatting for the tool result. Pure for testability.
export function formatDdgResults({ query, results = [], blocked = false, limit = 5 }) {
  if (blocked) {
    return (
      `Search was blocked by DuckDuckGo (bot challenge or rate limit). ` +
      `Try again in a bit or rephrase the query.`
    );
  }
  if (results.length === 0) {
    return `No results found for "${query}".`;
  }
  const header = `Search results for "${query}" (${results.length}${results.length >= limit ? "+" : ""}) — DuckDuckGo\n`;
  const lines = results.map((r, i) => {
    const base = `${i + 1}. [${r.title}](${r.url})`;
    return r.snippet ? `${base}\n   ${r.snippet}` : base;
  });
  return `${header}\n${lines.join("\n\n")}`;
}
