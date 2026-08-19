import { test } from "node:test";
import assert from "node:assert/strict";
import { extractReadable, isHtml } from "../fetch-content.mjs";

test("isHtml: explicit content-type", () => {
  assert.equal(isHtml({ contentType: "text/html; charset=utf-8", body: "x" }), true);
  assert.equal(isHtml({ contentType: "application/xhtml+xml", body: "x" }), true);
  assert.equal(isHtml({ contentType: "application/json", body: "x" }), false);
  assert.equal(isHtml({ contentType: "text/plain", body: "x" }), false);
});

test("isHtml: sniffs document doctype when content-type is missing or generic", () => {
  assert.equal(isHtml({ contentType: "", body: "<!doctype html><html>…" }), true);
  assert.equal(isHtml({ contentType: "", body: "<HTML>\n<head>" }), true);
  assert.equal(isHtml({ contentType: "text/plain", body: "<!DOCTYPE html><html>" }), true);
  assert.equal(isHtml({ contentType: "", body: '{"a":1}' }), false);
});

test("strips scripts, styles, noscript and comments", () => {
  const body =
    "<html><head><style>.x{color:red}</style></head><body>" +
    "<script>alert(1)</script><noscript>No JS</noscript><!-- hidden -->" +
    "<p>Hello</p></body></html>";
  const { text } = extractReadable({ contentType: "text/html", body });
  assert.ok(text.includes("Hello"));
  assert.ok(!text.includes("alert"));
  assert.ok(!text.includes(".x{"));
  assert.ok(!text.includes("No JS"));
  assert.ok(!text.includes("hidden"));
});

test("extracts the title and decodes named + numeric entities", () => {
  const body = "<title>Pi &amp; Co &mdash; FAQ &#39;n&#39; Stuff</title><p>a &lt; b &amp;&amp; c &gt; d &nbsp;e</p>";
  const { title, text } = extractReadable({ contentType: "text/html", body });
  assert.equal(title, "Pi & Co — FAQ 'n' Stuff");
  assert.ok(text.includes("a < b && c > d"));
});

test("collapses runs of blank lines", () => {
  const body = "<p>line one\n\n\n   spaced    out</p><p>next</p>";
  const { text } = extractReadable({ contentType: "text/html", body });
  assert.ok(!text.includes("\n\n\n"), "no triple newlines");
  assert.ok(text.includes("line one"));
});

test("non-HTML payload passes through trimmed, no title", () => {
  const { text, title, truncated } = extractReadable({
    contentType: "application/json",
    body: '  {"a": 1}  ',
  });
  assert.equal(text, '{"a": 1}');
  assert.equal(title, "");
  assert.equal(truncated, false);
});

test("caps output at maxChars and marks truncated", () => {
  const body = "<p>" + "word ".repeat(1000) + "</p>";
  const { text, truncated } = extractReadable({ contentType: "text/html", body, maxChars: 100 });
  assert.equal(truncated, true);
  assert.ok(text.endsWith("[truncated]"));
  assert.ok(text.length <= 130, `text length ${text.length} <= 130`);
});

test("huge raw input is capped before extraction", () => {
  const body = "<p>" + "x".repeat(3_000_000) + "</p>";
  const { text } = extractReadable({ contentType: "text/html", body });
  assert.ok(text.length > 0);
  assert.ok(text.length < 3_000_000);
});

test("empty body yields empty text, not truncated", () => {
  const { text, truncated } = extractReadable({ contentType: "text/html", body: "" });
  assert.equal(text, "");
  assert.equal(truncated, false);
});
