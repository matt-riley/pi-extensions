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

## `web_search` — keyless DuckDuckGo search

`web_search(query, max_results?)` runs the query through DuckDuckGo's HTML
endpoint via the same HTTP layer as `web_fetch` (browser headers, redirects,
timeout, size caps) and returns ranked results as markdown: title, decoded
URL, and snippet. No API key, no third party beyond DuckDuckGo; it works with
any provider/model. Snippets and titles are entity-decoded and cleaned with
the shared tokenizer.

Notes:

- Result links arrive wrapped in `//duckduckgo.com/l/?uddg=…` redirects;
  the real destination is decoded before being returned.
- If DuckDuckGo serves its bot-challenge page (HTTP 202 or anomaly markers)
  instead of results, the tool reports that explicitly rather than a bogus
  "no results".
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
    "useGh": true
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
