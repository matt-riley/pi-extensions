# pi-web-fetch — browser-grade web fetching & search for pi

Zero-dependency `web_fetch` / `batch_web_fetch` / `web_search` tools:
browser-like request headers, clean readable extraction, page metadata,
redirect handling, GitHub URLs via the `gh` CLI, bounded-concurrency batch
fetching, and keyless web search via DuckDuckGo.

## Tools

```
web_fetch(url, format?, maxChars?, timeoutMs?, headers?, includeImages?, followAlternates?)
batch_web_fetch(requests, concurrency?, totalMaxChars?)
web_search(query, max_results?)
```

`web_fetch` returns a metadata header (`title`, `url`, `published`, `author`,
`site`, `lang`, `via`) followed by the extracted content in the requested
format. `batch_web_fetch` fans out with bounded concurrency and reports each
item's result (or failure) independently. `web_search` returns ranked
DuckDuckGo results (title, URL, snippet) without an API key.

## Output formats

| Format | What you get |
| --- | --- |
| `markdown` | Default. Clean readable content: headings, paragraphs, links, lists, code fences, tables, blockquotes. |
| `html` | The same content as cleaned, pretty-printed HTML. |
| `text` | Plain text with markdown syntax stripped. |
| `json` | Structured: metadata fields + markdown content. |
| `raw` | The unmodified response body (html/text), capped at 200k chars by default. |

## What makes it "smart"

- **Browser-like headers** — realistic Chrome user agent, `accept`,
  `accept-language`, and `sec-fetch-*` navigation headers. Better success on
  bot-defended pages that check headers. This is *not* TLS fingerprint
  impersonation (that needs native deps this extension deliberately avoids).
- **Chrome-free extraction** — scripts, styles, navs, footers, sidebars,
  forms, ads, and comment widgets are stripped by tag and class/id heuristics;
  the main content is picked by semantic element (`article` → `main` →
  highest-text block) and converted to markdown.
- **Metadata** — title, description, author, site name, published date,
  language, canonical URL from `<head>`.
- **Redirects, both kinds** — HTTP redirects (manual loop, capped) and
  client-side `<meta http-equiv="refresh">`, with a combined hop budget.
- **Alternate-content fallback** — when a page extracts thin (< 250 chars),
  `web_fetch` follows qualified `<link rel="alternate">` entries matching the
  requested format (`text/markdown`, `text/plain`, `application/json`) and
  refetches.
- **Charset-aware** — respects `content-type` charset, `<meta charset>`, and
  `http-equiv` charset declarations; decodes with `TextDecoder`.
- **Size-capped reads** — bodies are streamed with a hard cap (4 MB for
  text/html, 64 KB probe for binaries), so a 2 GB attachment can't eat
  memory.
- **Binary handling** — non-text payloads are reported by content-type and
  size instead of being slurped into context. Fetch a text/JSON
  representation instead (e.g. GitHub raw, an API endpoint).

## `web_search` — keyless web search

`web_search(query, max_results?)` returns ranked results as markdown: title,
URL, and snippet. No API key; works with any provider/model.

**Engine selection** — DuckDuckGo by default; set `searxngUrl` in settings to
point `web_search` at a self-hosted SearXNG instance (JSON API, aggregates
many engines, no scraping):

```json
{ "webFetch": { "searxngUrl": "https://searxng.example.com" } }
```

A bare base URL gets the `/search` path appended. `format=json` must be
enabled on the instance (default for self-hosted; most public instances
disable it). Invalid or missing instances fall back to an explicit error,
never a silent empty result.

Notes:

- DuckDuckGo result links arrive wrapped in `//duckduckgo.com/l/?uddg=…`
  redirects; the real destination is decoded before being returned, and ad
  blocks (`result--ad` wrappers / `duckduckgo.com/y.js` trackers) are
  filtered out.
- If DuckDuckGo serves its bot-challenge page (HTTP 202 or anomaly markers)
  instead of results, the tool reports that explicitly; a redirect to the
  DDG homepage (no `q=` param) is reported as rate-limiting rather than a
  bogus "no results".
- The HTML endpoint is scrape-friendly but rate-limited: keep queries modest
  and prefer `web_fetch` when you already have the URL. The parser is
  unit-tested against captured real markup (`test/search.test.mjs`).

## GitHub URLs use `gh`

For `github.com` / `gist.github.com` URLs, `web_fetch` prefers the `gh` CLI
when it is installed **and** authenticated (`gh auth status`), because it
gives authenticated, structured data instead of scraped HTML:

| URL shape | What you get |
| --- | --- |
| `github.com/owner/repo` | repo metadata + README |
| `…/blob/ref/path` or `…/raw/…` | raw file content (markdown passthrough or fenced code) |
| `…/tree/ref/path` | directory listing |
| `…/issues/N`, `…/pull/N` | issue/PR with comments |
| `…/discussions/N` | discussion |
| `…/releases`, `…/releases/tag/x` | releases |
| `…/commit/sha`, `…/commits` | commit / commit list |
| `gist.github.com/…` | gist files |
| `github.com/owner` | profile |

`gh` availability is probed once per session (cached) — set
`"webFetch": { "useGh": false }` in settings to disable. When `gh` is missing
or unauthenticated, GitHub URLs fall back to plain HTTP automatically. Unhandled
GitHub paths (`/actions`, `/settings`, …) also fall back to HTTP.

## Settings

Optional keys in `~/.pi/agent/settings.json` or `<project>/.pi/settings.json`
(project overrides global). Flat `webFetchDefault*` keys and a nested
`webFetch: { ... }` object are both accepted:

```json
{
  "webFetch": {
    "defaultFormat": "markdown",
    "defaultMaxChars": 60000,
    "defaultTimeoutMs": 15000,
    "batchConcurrency": 4,
    "userAgent": "",
    "extraHeaders": {},
    "followAlternates": true,
    "includeImages": false,
    "useGh": true,
    "searxngUrl": ""
  }
}
```

| Key | Default | Description |
| --- | ---: | --- |
| `defaultFormat` | `markdown` | Default output format |
| `defaultMaxChars` | `60000` | Default content cap (raw defaults to 200000) |
| `defaultTimeoutMs` | `15000` | Request timeout |
| `batchConcurrency` | `4` | Bounded concurrency for `batch_web_fetch` |
| `userAgent` | Chrome UA | Override the browser user agent |
| `extraHeaders` | `{}` | Extra headers sent on every request |
| `followAlternates` | `true` | Alternate-content fallback |
| `includeImages` | `false` | Keep markdown image references |
| `useGh` | `true` | Prefer `gh` for GitHub URLs |
| `searxngUrl` | `""` | Self-hosted SearXNG instance (JSON API) — `web_search` uses it instead of DuckDuckGo |

## Limitations

- **No JavaScript execution.** JS-rendered pages need a browser automation
  tool; `web_fetch` only sees the static HTML.
- **No TLS fingerprint impersonation.** Only header-level browser simulation
  (see above).
- **No file downloads.** Binary payloads are reported, not saved (the fetch
  tool stays read-only).
- **Heuristic extraction** is tuned for articles/blog/docs; unusual layouts
  may extract imperfectly — use `format=raw` to see the source.

## Development

```sh
npm test                          # node --test on packages/**/*.test.mjs
npm run check                     # bun build --no-bundle entrypoints + tests
```

The parsing/extraction/formatting logic lives in plain `.mjs` modules with
`node --test` coverage; `index.ts` is only the pi tool wiring.
