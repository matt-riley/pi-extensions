// fetch.mjs — HTTP layer for web_fetch: browser-like headers, manual redirect
// loop with a hop budget, timeout + abort, size-capped streaming reads,
// charset detection, meta-refresh following, `<link rel=alternate>` fallback
// for thin pages, and the GitHub `gh` dispatch.
//
// fetchPage accepts an injected `fetcher` (defaults to globalThis.fetch) so
// the whole navigation chain is testable without a network.

import {
  DEFAULT_MAX_CHARS,
  RAW_DEFAULT_MAX_CHARS,
  extractPage,
  isBinaryMime,
  isHtmlContent,
  isTextMime,
  parseContentType,
  truncateText,
  THIN_CONTENT_CHARS,
} from "./extract.mjs";
import { ghAvailable, isGithubUrl, parseGithubUrl, fetchGithub } from "./github.mjs";

const MAX_RAW_BYTES = 4_000_000; // hard cap on bytes read for html/text
const BINARY_PROBE_BYTES = 64_000; // binary payloads: sniff, don't slurp
const MAX_STEPS = 10; // total http redirects + meta refreshes + alternates

const DEFAULT_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export const DEFAULT_HEADERS = {
  "user-agent": DEFAULT_UA,
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "upgrade-insecure-requests": "1",
  "sec-fetch-dest": "document",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-user": "?1",
};

export function buildHeaders({ userAgent = "", extraHeaders = {} } = {}) {
  const headers = { ...DEFAULT_HEADERS };
  if (userAgent) headers["user-agent"] = userAgent;
  for (const [k, v] of Object.entries(extraHeaders ?? {})) {
    if (v === undefined || v === null) continue;
    headers[String(k).toLowerCase()] = String(v);
  }
  return headers;
}

export function normalizeUrl(raw) {
  const url = new URL(String(raw ?? "").trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Unsupported protocol "${url.protocol}" — only http(s) URLs are supported.`);
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  return url;
}

export function safeResolve(href, base) {
  try {
    const u = new URL(href, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u;
  } catch {
    return null;
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function detectCharset({ mime = "", headerCharset = "", bodyPrefix = "" } = {}) {
  if (headerCharset) return normalizeCharset(headerCharset);
  const meta = /<meta[^>]+charset\s*=\s*["']?\s*([a-zA-Z0-9_\-]+)/i.exec(bodyPrefix);
  if (meta) return normalizeCharset(meta[1]);
  const metaCt = /<meta[^>]+http-equiv\s*=\s*["']?content-type["']?[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([a-zA-Z0-9_\-]+)/i.exec(bodyPrefix);
  if (metaCt) return normalizeCharset(metaCt[1]);
  return mime.includes("text/") || mime.includes("xml") ? "utf-8" : "";
}

function normalizeCharset(cs) {
  const c = cs.toLowerCase();
  if (c === "utf8") return "utf-8";
  if (c === "latin1" || c === "iso-8859-1" || c === "ascii" || c === "us-ascii") return "windows-1252";
  return c;
}

// Parse one attribute out of a raw tag. Handles double-quoted, single-quoted,
// and unquoted values; the \b boundary keeps the name from matching inside
// other attributes (e.g. "name" vs "itemprop").
function tagAttr(tag, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
  const m = re.exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : "";
}

// <meta http-equiv="refresh" content="N; url=..."> — returns { delay, url } or null.
export function parseMetaRefresh(html) {
  const re = /<meta\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    if (tagAttr(tag, "http-equiv").toLowerCase() !== "refresh") continue;
    const content = tagAttr(tag, "content");
    const dm = /^\s*(\d+)\s*(?:;\s*url\s*=\s*(.+?))?\s*$/i.exec(content.trim());
    if (!dm) continue;
    const url = (dm[2] ?? "").trim().replace(/^["']|["']$/g, "").trim();
    return { delay: Number(dm[1]), url };
  }
  return null;
}

// <link rel="alternate" type="..." href="..."> entries from <head>.
export function parseAlternates(html) {
  const out = [];
  const re = /<link\b[^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const tag = m[0];
    const rel = tagAttr(tag, "rel").toLowerCase().split(/\s+/);
    if (!rel.includes("alternate")) continue;
    out.push({
      href: tagAttr(tag, "href"),
      type: tagAttr(tag, "type").toLowerCase(),
    });
  }
  return out;
}

// Which alternate content types satisfy a requested format.
export function alternateForFormat(alternates, format) {
  const match = (type) => {
    switch (format) {
      case "markdown":
        return type.startsWith("text/markdown") || type.startsWith("application/markdown") || type.endsWith("+markdown");
      case "text":
        return type === "text/plain" || type.endsWith("+text");
      case "json":
        return type === "application/json" || type.endsWith("+json");
      default:
        return false;
    }
  };
  return alternates.find((a) => a.href && match(a.type));
}

// --- the fetch chain --------------------------------------------------------

// One GET + manual redirect loop, body read with caps, charset decoding.
// Returns { kind: "html"|"text"|"binary", body, finalUrl, status, statusText,
// mime, charset }.
async function httpGet(url, opts, state, fetcher) {
  const { controller, timedOut, cleanup } = createAbort(opts.timeoutMs ?? 15000, opts.signal);
  try {
    let current = url;
    let response = null;
    while (true) {
      response = await fetcher(current, {
        redirect: "manual",
        headers: buildHeaders({ userAgent: opts.userAgent, extraHeaders: opts.extraHeaders }),
        signal: controller.signal,
      });
      if (REDIRECT_STATUSES.has(response.status) && response.headers.get("location")) {
        state.steps += 1;
        if (state.steps > MAX_STEPS) {
          throw new Error(`Too many redirects (${MAX_STEPS} max).`);
        }
        const target = safeResolve(response.headers.get("location"), current);
        try {
          await response.body?.cancel();
        } catch {
          /* ignore */
        }
        if (!target) {
          throw new Error(`Redirect target is not http(s): ${response.headers.get("location")}`);
        }
        current = target;
        continue;
      }
      break;
    }

    const ctype = response.headers.get("content-type") ?? "";
    const { mime, charset: headerCharset } = parseContentType(ctype);
    const status = response.status;
    const finalUrl = String(current);

    if (status >= 400) {
      // Read a small snippet for the error message, then bail.
      const snippet = await readBody(response, 2000, controller.signal);
      const text = new TextDecoder("utf-8").decode(snippet).replace(/\s+/g, " ").trim().slice(0, 300);
      throw new Error(
        `HTTP ${status} ${response.statusText ?? ""} for ${finalUrl}${text ? ` — ${text}` : ""}`,
      );
    }

    const isBin = isBinaryMime(mime);
    const capBytes = isBin ? BINARY_PROBE_BYTES : MAX_RAW_BYTES;
    const buf = await readBody(response, capBytes, controller.signal);

    if (isBin) {
      const sizeHint = Number(response.headers.get("content-length")) || undefined;
      return {
        kind: "binary",
        finalUrl,
        status,
        statusText: response.statusText ?? "",
        mime,
        sizeHint,
        probedBytes: buf.byteLength,
      };
    }

    const prefix = buf.subarray(0, 2048).toString("latin1");
    const charset = detectCharset({ mime, headerCharset, bodyPrefix: prefix });
    const body = new TextDecoder(charset || "utf-8").decode(buf);
    const kind = isHtmlContent({ mime, body }) ? "html" : "text";
    return { kind, finalUrl, status, statusText: response.statusText ?? "", mime, charset: charset || "utf-8", body };
  } catch (err) {
    if (timedOut()) {
      const ms = opts.timeoutMs ?? 15000;
      throw new Error(`Request timed out after ${ms >= 1000 ? `${Math.round(ms / 1000)}s` : `${ms}ms`}.`);
    }
    throw err;
  } finally {
    cleanup();
  }
}

async function readBody(response, capBytes, signal) {
  if (!response.body) {
    const text = await response.text();
    const buf = new TextEncoder().encode(text);
    return buf.subarray(0, capBytes);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = capBytes - total;
      if (room <= 0) break;
      chunks.push(room >= value.byteLength ? value : value.subarray(0, room));
      total += Math.min(value.byteLength, room);
      if (total >= capBytes) break;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }
  return Buffer.concat(chunks, total);
}

function createAbort(timeoutMs, outerSignal) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onOuter = () => controller.abort();
  outerSignal?.addEventListener("abort", onOuter, { once: true });
  return {
    controller,
    timedOut: () => timedOut,
    cleanup() {
      clearTimeout(timer);
      outerSignal?.removeEventListener("abort", onOuter);
    },
  };
}

// Fetch a chain: http redirects (inside httpGet), then meta-refresh
// redirects. Returns the final payload.
async function fetchChain(startUrl, opts, state, fetcher) {
  let url = startUrl;
  let payload;
  for (;;) {
    payload = await httpGet(url, opts, state, fetcher);
    if (payload.kind !== "html") return payload;

    const refresh = parseMetaRefresh(payload.body);
    if (!refresh || !refresh.url) return payload;

    const target = safeResolve(refresh.url, payload.finalUrl);
    if (!target || target.href === payload.finalUrl) return payload; // self-refresh: ignore

    state.steps += 1;
    if (state.steps > MAX_STEPS) {
      throw new Error(`Too many meta-refresh redirects (${MAX_STEPS} max).`);
    }
    state.via = `meta-refresh (${refresh.delay}s)`;
    url = target;
  }
}

// The public single-URL fetch: dispatch to gh for GitHub URLs (when enabled
// and available), otherwise the http chain + extraction + alternate fallback.
export async function fetchSmart(options, fetcher = globalThis.fetch) {
  const url = normalizeUrl(options.url);
  const useGh = options.useGh ?? true;
  if (useGh && isGithubUrl(url) && (await ghAvailable())) {
    const parsed = parseGithubUrl(url);
    if (parsed) {
      const result = await fetchGithub(parsed, {
        format: options.format,
        maxChars: options.maxChars,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      });
      if (result.usedGh) return result.outcome;
    }
  }
  return fetchPage(options, fetcher);
}

export async function fetchPage(options, fetcher = globalThis.fetch) {
  const {
    url,
    format = "markdown",
    maxChars,
    timeoutMs = 15000,
    userAgent = "",
    extraHeaders = {},
    includeImages = false,
    followAlternates = true,
    signal,
    onStatus,
  } = options;

  const effectiveMaxChars =
    maxChars ?? (format === "raw" ? RAW_DEFAULT_MAX_CHARS : DEFAULT_MAX_CHARS);
  const state = { steps: 0, via: undefined };

  let payload = await fetchChain(url, { ...options, timeoutMs, userAgent, extraHeaders }, state, fetcher);
  onStatus?.("extracting");

  // Alternate-content fallback for thin pages.
  if (
    payload.kind === "html" &&
    followAlternates &&
    format !== "html" &&
    format !== "raw"
  ) {
    const alternates = parseAlternates(payload.body);
    const alt = alternateForFormat(alternates, format);
    if (alt) {
      const extracted = extractPage({
        contentType: payload.mime,
        body: payload.body,
        includeImages,
        maxChars: effectiveMaxChars,
      });
      const thin = extracted.kind === "page" && extracted.rawTextLength < THIN_CONTENT_CHARS;
      const target = alt.href ? safeResolve(alt.href, payload.finalUrl) : null;
      if (thin && target && target.href !== payload.finalUrl && state.steps < MAX_STEPS) {
        state.steps += 1;
        state.via = `alternate ${alt.type}`;
        onStatus?.(`following alternate ${alt.type}`);
        payload = await fetchChain(target, { ...options, timeoutMs, userAgent, extraHeaders }, state, fetcher);
      }
    }
  }

  return finalize(payload, { format, maxChars: effectiveMaxChars, includeImages, via: state.via });
}

function finalize(payload, { format, maxChars, includeImages, via }) {
  if (payload.kind === "binary") {
    return {
      kind: "binary",
      finalUrl: payload.finalUrl,
      status: payload.status,
      statusText: payload.statusText,
      mime: payload.mime,
      sizeHint: payload.sizeHint,
      probedBytes: payload.probedBytes,
      via,
    };
  }

  if (payload.kind === "text") {
    const capped = truncateText(payload.body, format === "raw" ? Math.max(maxChars, 100000) : maxChars);
    return {
      kind: "text",
      finalUrl: payload.finalUrl,
      status: payload.status,
      statusText: payload.statusText,
      mime: payload.mime,
      text: capped.text,
      truncated: capped.truncated,
      via,
    };
  }

  // html payload
  if (format === "raw") {
    const capped = truncateText(payload.body, maxChars);
    return {
      kind: "raw",
      finalUrl: payload.finalUrl,
      status: payload.status,
      statusText: payload.statusText,
      mime: payload.mime,
      text: capped.text,
      truncated: capped.truncated,
      via,
    };
  }

  const extracted = extractPage({
    contentType: payload.mime,
    body: payload.body,
    includeImages,
    maxChars,
  });

  if (extracted.kind === "binary") {
    return {
      kind: "binary",
      finalUrl: payload.finalUrl,
      status: payload.status,
      statusText: payload.statusText,
      mime: payload.mime,
      sizeHint: undefined,
      probedBytes: payload.body.length,
      via,
    };
  }

  if (extracted.kind === "text") {
    return {
      kind: "text",
      finalUrl: payload.finalUrl,
      status: payload.status,
      statusText: payload.statusText,
      mime: payload.mime,
      text: extracted.text,
      truncated: extracted.truncated,
      via,
    };
  }

  return {
    kind: "page",
    finalUrl: payload.finalUrl,
    status: payload.status,
    statusText: payload.statusText,
    mime: payload.mime,
    charset: payload.charset,
    via,
    ...extracted.meta,
    markdown: extracted.markdown,
    html: extracted.html,
    text: extracted.text,
    rawTextLength: extracted.rawTextLength,
    truncated: extracted.truncated,
  };
}
