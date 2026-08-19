import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MAX_CHARS,
  extractPage,
  isBinaryMime,
  isHtmlContent,
  isTextMime,
  parseContentType,
  truncateText,
} from "../extract.mjs";

const ARTICLE = `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Test Article</title>
  <meta name="author" content="Ada">
  <meta property="article:published_time" content="2026-08-19T00:00:00Z">
</head>
<body>
  <nav>menu</nav>
  <article>
    <h1>Hello World</h1>
    <p>This is the <b>main</b> content with a <a href="https://x.dev">link</a>.</p>
    <pre><code class="language-js">const x = 1;</code></pre>
  </article>
  <footer>copyright</footer>
</body>
</html>`;

test("extractPage: html → metadata + markdown", () => {
  const out = extractPage({ contentType: "text/html; charset=utf-8", body: ARTICLE });
  assert.equal(out.kind, "page");
  assert.equal(out.meta.title, "Test Article");
  assert.equal(out.meta.author, "Ada");
  assert.equal(out.meta.published, "2026-08-19T00:00:00Z");
  assert.match(out.markdown, /# Hello World/);
  assert.match(out.markdown, /\[link\]\(https:\/\/x\.dev\)/);
  assert.match(out.markdown, /```js\nconst x = 1;\n```/);
  assert.ok(!out.markdown.includes("menu"));
  assert.ok(!out.markdown.includes("copyright"));
});

test("extractPage: html sniffed without content-type", () => {
  const out = extractPage({ contentType: "", body: "<!doctype html><html><body><p>hi</p></body></html>" });
  assert.equal(out.kind, "page");
});

test("extractPage: text payloads pass through", () => {
  const out = extractPage({ contentType: "application/json", body: '{"a": 1}' });
  assert.equal(out.kind, "text");
  assert.equal(out.text, '{"a": 1}');
});

test("extractPage: binary mime", () => {
  const out = extractPage({ contentType: "application/pdf", body: "%PDF-1.4 junk" });
  assert.equal(out.kind, "binary");
});

test("truncateText: word boundary", () => {
  const text = "one two three four five six seven eight nine ten";
  const { text: cut, truncated } = truncateText(text, 20);
  assert.equal(truncated, true);
  assert.ok(cut.endsWith("… [truncated]"));
  assert.ok(!cut.slice(0, -14).endsWith(" ")); // not cut mid-word
  assert.equal(truncateText("short", DEFAULT_MAX_CHARS).truncated, false);
});

test("content-type helpers", () => {
  assert.deepEqual(parseContentType("text/html; charset=utf-8"), { mime: "text/html", charset: "utf-8" });
  assert.equal(isHtmlContent({ mime: "text/html" }), true);
  assert.equal(isHtmlContent({ mime: "text/plain", body: "<html><body>x</body></html>" }), true);
  assert.equal(isTextMime("application/json"), true);
  assert.equal(isTextMime("image/png"), false);
  assert.equal(isBinaryMime("application/octet-stream"), true);
});
