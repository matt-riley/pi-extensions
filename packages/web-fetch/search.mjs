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

// Build a SearXNG JSON-API query URL on a user-supplied instance base
// (e.g. https://searxng.example.com). format=json must be enabled on the
// instance; self-hosted instances enable it by default.
export function buildSearxngUrl(baseUrl, query, { pageno = 1, safesearch = 0 } = {}) {
  const url = new URL(String(baseUrl ?? "")); // throws on invalid base
  // Instances serve the API under /search; accept a bare base URL or one
  // that sits behind a reverse-proxy path (e.g. …/searxng on tailnet serve).
  if (!url.pathname.endsWith("/search")) {
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/search`;
  }
  url.searchParams.set("q", String(query ?? "").trim());
  url.searchParams.set("format", "json");
  url.searchParams.set("pageno", String(pageno));
  url.searchParams.set("safesearch", String(safesearch));
  return url.href;
}

// Parse a SearXNG JSON API response body into the shared result shape.
// Returns { results, error? } — error is set for non-JSON bodies and for
// SearXNG's own { error: "..." } responses.
export function parseSearxngResults(body, { limit = 5 } = {}) {
  let data;
  try {
    data = JSON.parse(String(body ?? ""));
  } catch {
    return { results: [], error: "SearXNG returned a non-JSON response." };
  }
  if (typeof data?.error === "string" && data.error) {
    return { results: [], error: `SearXNG: ${data.error}` };
  }
  const results = [];
  const list = Array.isArray(data?.results) ? data.results : [];
  for (const r of list) {
    if (results.length >= limit) break;
    const title = String(r?.title ?? "").replace(/\s+/g, " ").trim();
    const url = String(r?.url ?? "").trim();
    if (!title || !url) continue;
    const snippet = String(r?.content ?? "").replace(/\s+/g, " ").trim();
    results.push({ title, url, snippet });
  }
  return { results };
}

// DDG sometimes responds to scrape-y requests by redirecting to its homepage
// (final URL without a q= parameter) instead of serving results.
export function isDdgHomepageRedirect(finalUrl) {
  if (!finalUrl) return false;
  let url;
  try {
    url = new URL(finalUrl);
  } catch {
    return false;
  }
  const host = url.hostname;
  const ddgHost = host === "duckduckgo.com" || host.endsWith(".duckduckgo.com");
  return ddgHost && !url.searchParams.has("q");
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

// Heuristics for telling "DDG genuinely has no results" apart from "DDG
// changed its markup and the parser found nothing" (parseDdgResults'
// `parseFailed` flag below). A real no-results DDG page is short-ish HTML
// that still carries DDG branding plus explicit no-results copy; a page
// where the parser bit-rotted is a substantial, clearly-DDG page yielding
// zero result__body blocks (or blocks that never resolve into a title+url)
// without that copy — most likely because DDG renamed/restructured the
// result markup this parser targets.
const SUBSTANTIAL_HTML_CHARS = 1000;
const DDG_PAGE_MARKER = /duckduckgo/i;
const NO_RESULTS_TEXT = /no\s+results|zero\s+results|did not match any/i;

// Parse organic results out of a raw DuckDuckGo HTML response body.
// Returns { results, blocked, parseFailed }:
//   results     — [{ title, url, snippet }], capped at `limit`
//   blocked     — always false here; use isDdgBlocked() for challenge detection
//   parseFailed — true when the page looks like a substantial DDG results
//                 page but the parser extracted zero results and the page
//                 doesn't carry DDG's own "no results" copy — i.e. probable
//                 markup bit-rot rather than a genuine empty result set.
//
// Token-stream based (not buildTree): DDG's result divs nest legitimately
// (wrapper > result__body > extras > ...), and buildTree's same-name div
// guard flattens nested divs on purpose for content extraction. A dedicated
// open/close stack preserves the real nesting just long enough to capture
// each result__body block.
export function parseDdgResults(html, { limit = 5 } = {}) {
  const results = [];
  const htmlStr = String(html ?? "");
  if (!htmlStr) return { results, blocked: false, parseFailed: false };

  const tokens = tokenize(htmlStr);

  // Pass 1: locate each div.result__body and its matching close token.
  // Skip ad blocks: their wrapper carries the result--ad class, and even if
  // that class changes, ad links decode to a duckduckgo.com y.js tracker
  // rather than an external destination (checked in pass 2).
  const opens = [];
  const bodies = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "tag") {
      if (!VOID_TAGS.has(t.name)) {
        if (t.name === "div" && tokenHasClass(t, "result__body")) {
          const wrapperClass = opens.length > 0 ? tokenClass(tokens[opens[opens.length - 1]]) : "";
          const isAdWrapper = /(^|\s)result--ad(\s|$)/.test(wrapperClass);
          if (!isAdWrapper) bodies.push({ start: i, end: -1 });
        }
        opens.push(i);
      }
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
    // Ad/tracker links stay on duckduckgo.com after decoding; organic
    // results always point elsewhere.
    let host = "";
    try {
      host = new URL(block.url).hostname;
    } catch {
      continue;
    }
    if (host === "duckduckgo.com" || host.endsWith(".duckduckgo.com")) continue;
    results.push(block);
  }

  const parseFailed =
    results.length === 0 &&
    htmlStr.length >= SUBSTANTIAL_HTML_CHARS &&
    DDG_PAGE_MARKER.test(htmlStr) &&
    !NO_RESULTS_TEXT.test(htmlStr);

  return { results, blocked: false, parseFailed };
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
// `engine` labels the source ("DuckDuckGo" or "SearXNG"); `redirected`
// distinguishes a bot bounce (DDG homepage redirect) from a genuine no-result.
export function formatSearchResults({
  query,
  results = [],
  blocked = false,
  redirected = false,
  parseFailed = false,
  limit = 5,
  engine = "DuckDuckGo",
}) {
  if (blocked) {
    return (
      `Search was blocked by ${engine} (bot challenge or rate limit). ` +
      `Try again in a bit or rephrase the query.`
    );
  }
  if (redirected) {
    return (
      `${engine} redirected the request to its homepage instead of results — ` +
      `likely rate-limited. Try again shortly or rephrase.`
    );
  }
  if (parseFailed) {
    return (
      `${engine} returned a page, but its results markup could not be parsed (the site's HTML may have changed) — ` +
      `this is not necessarily a genuine no-results answer. Try again, rephrase the query, or configure a ` +
      `SearXNG instance (webFetchSearxngUrl) as a more stable backend.`
    );
  }
  if (results.length === 0) {
    return `No results found for "${query}".`;
  }
  const header = `Search results for "${query}" (${results.length}${results.length >= limit ? "+" : ""}) — ${engine}\n`;
  const lines = results.map((r, i) => {
    const base = `${i + 1}. [${r.title}](${r.url})`;
    return r.snippet ? `${base}\n   ${r.snippet}` : base;
  });
  return `${header}\n${lines.join("\n\n")}`;
}
