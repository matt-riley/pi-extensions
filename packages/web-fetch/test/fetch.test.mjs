import { test } from "node:test";
import assert from "node:assert/strict";
import {
  alternateForFormat,
  buildHeaders,
  detectCharset,
  fetchPage,
  fetchSmart,
  normalizeUrl,
  parseAlternates,
  parseMetaRefresh,
} from "../fetch.mjs";
import { _setGhAvailable } from "../github.mjs";

// --- pure helpers -----------------------------------------------------------

test("normalizeUrl: validates and cleans", () => {
  assert.equal(normalizeUrl("https://example.com/a#frag").href, "https://example.com/a");
  assert.equal(normalizeUrl("https://user:pass@example.com/").href, "https://example.com/");
  assert.throws(() => normalizeUrl("ftp://example.com"), /Unsupported protocol/);
  assert.throws(() => normalizeUrl("not a url"), TypeError);
});

test("buildHeaders: defaults + overrides", () => {
  const h = buildHeaders();
  assert.match(h["user-agent"], /Mozilla\/5\.0/);
  assert.equal(h["sec-fetch-dest"], "document");
  const custom = buildHeaders({ userAgent: "custom", extraHeaders: { Accept: "text/plain", "x-token": "1" } });
  assert.equal(custom["user-agent"], "custom");
  assert.equal(custom.accept, "text/plain"); // case-insensitive override
  assert.equal(custom["x-token"], "1");
});

test("detectCharset: header > meta > http-equiv > default", () => {
  assert.equal(detectCharset({ headerCharset: "shift_jis" }), "shift_jis");
  assert.equal(detectCharset({ bodyPrefix: '<meta charset="iso-8859-1">' }), "windows-1252");
  assert.equal(detectCharset({ bodyPrefix: '<meta http-equiv="Content-Type" content="text/html; charset=utf-8">' }), "utf-8");
  assert.equal(detectCharset({ mime: "text/html" }), "utf-8");
});

test("parseMetaRefresh: forms", () => {
  assert.deepEqual(parseMetaRefresh('<meta http-equiv="refresh" content="0; url=/new">'), { delay: 0, url: "/new" });
  assert.deepEqual(parseMetaRefresh(`<meta http-equiv='refresh' content='5; url="https://x.com/"'>`), { delay: 5, url: "https://x.com/" });
  assert.deepEqual(parseMetaRefresh('<meta http-equiv="refresh" content="30">'), { delay: 30, url: "" });
  assert.equal(parseMetaRefresh("<meta name=description content=x>"), null);
});

test("parseAlternates + alternateForFormat", () => {
  const html = '<head><link rel="alternate" type="text/markdown" href="/doc.md">' +
    '<link rel="alternate" type="application/atom+xml" href="/feed">' +
    '<link rel="stylesheet" href="/s.css"></head>';
  const alts = parseAlternates(html);
  assert.equal(alts.length, 2);
  const md = alternateForFormat(alts, "markdown");
  assert.equal(md.href, "/doc.md");
  assert.equal(alternateForFormat(alts, "json"), undefined);
});

// --- fetch chain with injected fetcher --------------------------------------

function route(routes) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push(String(url));
    const u = new URL(String(url));
    const key = u.pathname + u.search;
    const hit = routes[key] ?? routes["*"];
    if (!hit) return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    if (typeof hit === "function") return hit(url, init);
    const headers = { "content-type": hit.ct ?? "text/html" };
    if (hit.location) headers.location = hit.location;
    return new Response(hit.body ?? "", { status: hit.status ?? 200, headers });
  };
  fn.calls = calls;
  return fn;
}

const PAGE = "<html><head><title>Doc</title></head><body><article><h1>Heading</h1><p>" +
  "Some real content that is long enough to extract. ".repeat(10) + "</p></article></body></html>";

test("fetchPage: simple html page", async () => {
  const fetcher = route({ "/": { body: PAGE } });
  const out = await fetchPage({ url: "https://example.com/", timeoutMs: 5000 }, fetcher);
  assert.equal(out.kind, "page");
  assert.equal(out.title, "Doc");
  assert.match(out.markdown, /# Heading/);
});

test("fetchPage: redirect followed with budget", async () => {
  const fetcher = route({
    "/old": { status: 302, location: "/new" },
    "/new": { body: PAGE },
  });
  const out = await fetchPage({ url: "https://example.com/old", timeoutMs: 5000 }, fetcher);
  assert.equal(out.kind, "page");
  assert.equal(out.finalUrl, "https://example.com/new");
});

test("fetchPage: redirect loop errors", async () => {
  const fetcher = route({
    "/loop": { status: 302, location: "/loop" },
  });
  await assert.rejects(
    fetchPage({ url: "https://example.com/loop", timeoutMs: 5000 }, fetcher),
    /Too many redirects/,
  );
});

test("fetchPage: meta refresh followed", async () => {
  const fetcher = route({
    "/": { body: '<html><head><meta http-equiv="refresh" content="0; url=/real"></head><body></body></html>' },
    "/real": { body: PAGE },
  });
  const out = await fetchPage({ url: "https://example.com/", timeoutMs: 5000 }, fetcher);
  assert.equal(out.kind, "page");
  assert.equal(out.finalUrl, "https://example.com/real");
  assert.match(out.via, /meta-refresh/);
});

test("fetchPage: self meta refresh ignored", async () => {
  const fetcher = route({
    "/": { body: '<html><head><meta http-equiv="refresh" content="30; url=/"></head><body>' + PAGE + "</body></html>" },
  });
  const out = await fetchPage({ url: "https://example.com/", timeoutMs: 5000 }, fetcher);
  assert.equal(fetcher.calls.length, 1);
  assert.equal(out.kind, "page");
});

test("fetchPage: alternate fallback when thin", async () => {
  const fetcher = route({
    "/": { body: '<html><head><link rel="alternate" type="text/markdown" href="/alt.md"></head><body><p>thin</p></body></html>' },
    "/alt.md": { body: "# Rich content\n\nLots of markdown here.", ct: "text/markdown" },
  });
  const out = await fetchPage({ url: "https://example.com/", timeoutMs: 5000 }, fetcher);
  assert.equal(out.kind, "text");
  assert.equal(out.text, "# Rich content\n\nLots of markdown here.");
  assert.match(out.via, /alternate text\/markdown/);
});

test("fetchPage: no alternate when content is thick", async () => {
  const fetcher = route({
    "/": { body: '<html><head><link rel="alternate" type="text/markdown" href="/alt.md"></head><body>' + PAGE + "</body></html>" },
  });
  const out = await fetchPage({ url: "https://example.com/", timeoutMs: 5000 }, fetcher);
  assert.equal(fetcher.calls.length, 1);
  assert.equal(out.kind, "page");
});

test("fetchPage: text payload (json api)", async () => {
  const fetcher = route({ "/api": { body: '{"ok": true}', ct: "application/json" } });
  const out = await fetchPage({ url: "https://example.com/api", timeoutMs: 5000 }, fetcher);
  assert.equal(out.kind, "text");
  assert.equal(out.text, '{"ok": true}');
});

test("fetchPage: binary payload reported, not read fully", async () => {
  const big = new Uint8Array(200_000).fill(65);
  const fetcher = route({ "/img": { body: big, ct: "image/png" } });
  const out = await fetchPage({ url: "https://example.com/img", timeoutMs: 5000 }, fetcher);
  assert.equal(out.kind, "binary");
  assert.equal(out.mime, "image/png");
  assert.ok(out.probedBytes <= 64_000);
});

test("fetchPage: http error status throws with snippet", async () => {
  const fetcher = route({ "/missing": { status: 404, body: "<html>not here</html>" } });
  await assert.rejects(
    fetchPage({ url: "https://example.com/missing", timeoutMs: 5000 }, fetcher),
    /HTTP 404/,
  );
});

test("fetchPage: timeout aborts", async () => {
  const hanging = (url, init) =>
    new Promise((resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    });
  await assert.rejects(
    fetchPage({ url: "https://example.com/slow", timeoutMs: 50 }, hanging),
    /timed out after 50ms/,
  );
});

// --- dispatch ---------------------------------------------------------------

test("fetchSmart: non-github URLs use http", async () => {
  _setGhAvailable(false);
  const fetcher = route({ "/": { body: PAGE } });
  const out = await fetchSmart({ url: "https://example.com/", timeoutMs: 5000 }, fetcher);
  assert.equal(out.kind, "page");
});

test("fetchSmart: github URL falls back to http when gh unavailable", async () => {
  _setGhAvailable(false);
  const fetcher = route({ "/foo/bar": { body: PAGE } });
  const out = await fetchSmart({ url: "https://github.com/foo/bar", timeoutMs: 5000 }, fetcher);
  assert.equal(out.kind, "page");
});
