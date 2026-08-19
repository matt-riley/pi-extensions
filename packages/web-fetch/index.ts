// web-fetch.ts — pi extension: browser-grade web fetching with clean
// extraction, metadata, and bounded-concurrency batch fetching.
//
// Registers:
//   web_fetch       — one URL → markdown/html/text/json/raw + metadata
//   batch_web_fetch — many URLs with bounded concurrency
//   web_search      — keyless DuckDuckGo web search (titles/URLs/snippets)
//
// GitHub URLs prefer the `gh` CLI (authenticated, structured) and fall back
// to plain HTTP when gh is missing or unauthenticated. Zero runtime
// dependencies: node: built-ins + pi's typebox only.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fetchPage, fetchSmart } from "./fetch.mjs";
import { formatBatchResult, formatWebFetchResult, isKnownFormat } from "./format.mjs";
import { buildDdgSearchUrl, formatDdgResults, isDdgBlocked, parseDdgResults } from "./search.mjs";
import { FORMATS, loadSettings } from "./settings.mjs";

const FORMAT_DESC =
  `Output format: ${FORMATS.join(", ")}. ` +
  "markdown = clean readable content (default); html = cleaned HTML; text = plain text; " +
  "json = structured metadata + content; raw = unmodified response body.";

const WEB_FETCH_DESCRIPTION = [
  "Fetch a URL with browser-like request headers and return clean, readable content plus metadata.",
  "Follows HTTP and meta-refresh redirects, falls back to <link rel=alternate> content when a page extracts thin, and uses the gh CLI for GitHub URLs when available.",
  "Does NOT execute JavaScript — use a browser automation tool for JS-rendered pages.",
].join(" ");

const BATCH_DESCRIPTION = [
  "Fetch multiple URLs in one call with bounded concurrency. Each item accepts the same options as web_fetch;",
  "individual failures are reported per item and do not fail the batch.",
].join(" ");

const SEARCH_DESCRIPTION = [
  "Search the web via DuckDuckGo (no API key required) and return ranked results with titles, URLs, and snippets.",
  "Use when you need current or source-backed information outside your training data: recent events, versions, docs, people.",
  "Results reflect DuckDuckGo's index; verify claims against the linked sources before citing them.",
].join(" ");

const SEARCH_SNIPPET =
  "web_search(query, max_results?): search the web via DuckDuckGo (no API key); returns ranked results with titles, URLs, and snippets — use for current/source-backed information beyond your training data";

const FORMAT_DEFAULT_BY_TOOL = "markdown";

function pickFormat(paramsFormat, settingsDefault, fallback = FORMAT_DEFAULT_BY_TOOL) {
  const value = typeof paramsFormat === "string" ? paramsFormat : settingsDefault;
  return isKnownFormat(value) ? value : fallback;
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

function errorText(prefix, err) {
  const message = err instanceof Error ? err.message : String(err);
  return `${prefix}: ${message}`;
}

function buildFetchOptions(params, settings, { format, maxChars, timeoutMs }) {
  const headers = {};
  if (params?.headers && typeof params.headers === "object") {
    for (const [k, v] of Object.entries(params.headers)) {
      if (typeof v === "string" || typeof v === "number") headers[k] = String(v);
    }
  }
  return {
    url: String(params?.url ?? "").trim(),
    format,
    maxChars,
    timeoutMs,
    headers,
    includeImages: typeof params?.includeImages === "boolean"
      ? params.includeImages
      : settings.includeImages,
    followAlternates: typeof params?.followAlternates === "boolean"
      ? params.followAlternates
      : settings.followAlternates,
    useGh: settings.useGh,
    userAgent: settings.userAgent,
    extraHeaders: settings.extraHeaders,
  };
}

export default function piWebFetchExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_fetch",
    label: "web_fetch",
    description: WEB_FETCH_DESCRIPTION,
    promptSnippet:
      "web_fetch(url, format?, maxChars?, timeoutMs?, headers?, includeImages?, followAlternates?): fetch a web page and get clean readable content (markdown by default) plus title/author/date metadata; GitHub URLs use the gh CLI; no JavaScript execution",
    promptGuidelines: [
      "Use web_fetch to fetch web pages: browser-like headers, redirect following, clean markdown extraction, and metadata. For GitHub URLs (repos, issues, PRs, files, releases, commits, gists) it uses the gh CLI for authenticated structured data.",
      "web_fetch does NOT execute JavaScript — use a browser automation tool for JS-rendered pages. Use format=raw to inspect the unmodified response body.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "The http(s) URL to fetch" }),
      format: Type.Optional(Type.String({ description: FORMAT_DESC })),
      maxChars: Type.Optional(Type.Integer({ minimum: 1000, description: "Maximum characters of extracted content (default 60000; format=raw defaults to 200000)." })),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1000, description: "Request timeout in milliseconds (default 15000)." })),
      headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Extra HTTP headers, e.g. { cookie: \"...\" } or a custom user-agent." })),
      includeImages: Type.Optional(Type.Boolean({ description: "Keep markdown image references (default false)." })),
      followAlternates: Type.Optional(Type.Boolean({ description: "Follow <link rel=alternate> content (text/markdown, text/plain, application/json) when a page extracts thin (default true)." })),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const settings = await loadSettings({ cwd: ctx.cwd });
      const rawUrl = String(params?.url ?? "").trim();
      if (!rawUrl) {
        return { content: [{ type: "text", text: "Rejected: url is empty." }] };
      }

      if (typeof params?.format === "string" && !isKnownFormat(params.format)) {
        return {
          content: [{
            type: "text",
            text: `Rejected: format must be one of ${FORMATS.join(", ")}. Got "${params.format}".`,
          }],
        };
      }

      const format = pickFormat(params?.format, settings.defaultFormat);
      const maxChars = clampInt(
        params?.maxChars,
        format === "raw" ? 200000 : settings.defaultMaxChars,
        1000,
        1_000_000,
      );
      const timeoutMs = clampInt(params?.timeoutMs, settings.defaultTimeoutMs, 1000, 120_000);

      const options = buildFetchOptions(params, settings, { format, maxChars, timeoutMs });

      try {
        new URL(options.url);
      } catch {
        return { content: [{ type: "text", text: `Rejected: "${options.url}" is not a valid URL.` }] };
      }

      onUpdate?.({ content: [{ type: "text", text: `Fetching ${options.url}…` }] });
      try {
        const outcome = await fetchSmart(
          {
            ...options,
            signal,
            onStatus: (status: string) =>
              onUpdate?.({ content: [{ type: "text", text: `web_fetch ${options.url}: ${status}` }] }),
          },
        );
        const text = formatWebFetchResult(outcome, { format, maxChars });
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return { content: [{ type: "text", text: errorText(`web_fetch failed for ${options.url}`, err) }] };
      }
    },
  });

  pi.registerTool({
    name: "batch_web_fetch",
    label: "batch_web_fetch",
    description: BATCH_DESCRIPTION,
    promptSnippet:
      "batch_web_fetch(requests, concurrency?, totalMaxChars?): fetch multiple URLs concurrently, one result block per URL with per-item failures",
    promptGuidelines: [
      "Use batch_web_fetch to fetch many URLs in one call with bounded concurrency; each request item accepts the same options as web_fetch and failures are reported per item.",
    ],
    parameters: Type.Object({
      requests: Type.Array(
        Type.Object({
          url: Type.String({ description: "The http(s) URL to fetch" }),
          format: Type.Optional(Type.String({ description: FORMAT_DESC })),
          maxChars: Type.Optional(Type.Integer({ minimum: 1000, description: "Per-item character cap (default 60000)." })),
          headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Extra HTTP headers for this item." })),
          includeImages: Type.Optional(Type.Boolean({ description: "Keep markdown image references (default false)." })),
          followAlternates: Type.Optional(Type.Boolean({ description: "Alternate-content fallback (default true)." })),
        }),
        { description: "1-25 URLs to fetch" },
      ),
      concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Bounded concurrency (default 4)." })),
      totalMaxChars: Type.Optional(Type.Integer({ minimum: 10000, description: "Total output budget across all items (default 300000)." })),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const settings = await loadSettings({ cwd: ctx.cwd });
      const requests = Array.isArray(params?.requests) ? params.requests : [];
      if (requests.length === 0) {
        return { content: [{ type: "text", text: "Rejected: requests is empty." }] };
      }
      if (requests.length > 25) {
        return { content: [{ type: "text", text: `Rejected: at most 25 URLs per batch, got ${requests.length}.` }] };
      }

      const concurrency = clampInt(params?.concurrency, settings.batchConcurrency, 1, 10);
      const totalBudget = clampInt(params?.totalMaxChars, 300000, 10000, 5_000_000);
      let remainingBudget = totalBudget;

      const items = requests.map((raw, index) => {
        const request = {
          url: String(raw?.url ?? "").trim(),
          format: pickFormat(raw?.format, settings.defaultFormat),
          maxChars: clampInt(raw?.maxChars, settings.defaultMaxChars, 1000, 1_000_000),
        };
        return { index, request };
      });

      const results = new Array(items.length);
      let next = 0;
      let doneCount = 0;
      const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        for (;;) {
          const i = next++;
          if (i >= items.length) return;
          const { index, request } = items[i];
          const budget = Math.min(request.maxChars, remainingBudget);
          remainingBudget = Math.max(0, remainingBudget - budget);
          const options = buildFetchOptions(request, settings, {
            format: request.format,
            maxChars: budget,
            timeoutMs: settings.defaultTimeoutMs,
          });
          try {
            const outcome = await fetchSmart({ ...options, signal });
            results[i] = { index, request, outcome };
          } catch (err) {
            results[i] = { index, request, error: errorText(`fetch failed`, err) };
          }
          doneCount += 1;
          onUpdate?.({
            content: [{ type: "text", text: `batch_web_fetch: ${doneCount}/${items.length} done` }],
          });
        }
      });
      await Promise.all(workers);

      const text = formatBatchResult(results, { concurrency });
      return { content: [{ type: "text", text }] };
    },
  });

  pi.registerTool({
    name: "web_search",
    label: "web_search",
    description: SEARCH_DESCRIPTION,
    promptSnippet: SEARCH_SNIPPET,
    promptGuidelines: [
      "Use web_search when you need current or source-backed information outside your training data (recent events, version numbers, docs, people). It is keyless (DuckDuckGo) and returns ranked results with titles, URLs, and snippets.",
      "After a search, synthesize an answer and cite the returned sources with markdown hyperlinks; do not invent URLs not present in the results.",
    ],
    parameters: Type.Object({
      query: Type.String({ minLength: 2, description: "The search query. Be specific and include relevant keywords." }),
      max_results: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Max results to return (default 5)." })),
    }),

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const settings = await loadSettings({ cwd: ctx.cwd });
      const query = String(params?.query ?? "").trim();
      if (query.length < 2) {
        return { content: [{ type: "text", text: "Rejected: query is too short." }] };
      }
      const limit = clampInt(params?.max_results, 5, 1, 10);
      const url = buildDdgSearchUrl(query);

      onUpdate?.({ content: [{ type: "text", text: `Searching DuckDuckGo for "${query}"…` }] });
      try {
        const outcome = await fetchPage({
          url,
          format: "raw",
          maxChars: 400_000,
          timeoutMs: settings.defaultTimeoutMs,
          userAgent: settings.userAgent,
          extraHeaders: settings.extraHeaders,
          signal,
          onStatus: (status: string) =>
            onUpdate?.({ content: [{ type: "text", text: `web_search: ${status}` }] }),
        });
        const body = outcome.kind === "raw" ? outcome.text : "";
        const blocked = isDdgBlocked({ status: outcome.status, body });
        const { results } = parseDdgResults(body, { limit });
        const text = formatDdgResults({ query, results, blocked, limit });
        return { content: [{ type: "text", text }], details: { results } };
      } catch (err) {
        return { content: [{ type: "text", text: errorText("web_search failed", err) }], isError: true };
      }
    },
  });
}
