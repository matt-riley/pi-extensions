import { test } from "node:test";
import assert from "node:assert/strict";
import { buildTree, stripBoilerplate, tokenize } from "../html.mjs";
import { treeToMarkdown, treeToText } from "../markdown.mjs";

function md(html, opts) {
  const tree = stripBoilerplate(buildTree(tokenize(html)));
  return treeToMarkdown(tree, opts);
}

test("headings and paragraphs", () => {
  const out = md("<body><h1>One</h1><p>para one</p><h2>Two</h2><p>para two</p></body>");
  assert.equal(out, "# One\n\npara one\n\n## Two\n\npara two");
});

test("links: href, title, javascript: dropped, self-link collapsed", () => {
  assert.equal(md('<p><a href="https://x.com">X</a></p>'), "[X](https://x.com)");
  assert.equal(md('<p><a href="https://x.com" title="t">X</a></p>'), '[X](https://x.com "t")');
  assert.equal(md('<p><a href="javascript:alert(1)">bad</a></p>'), "bad");
  assert.equal(md('<p><a href="https://x.com">https://x.com</a></p>'), "https://x.com");
});

test("inline emphasis and code", () => {
  assert.equal(md("<p>a <strong>b</strong> <em>c</em> <code>x()</code></p>"), "a **b** *c* `x()`");
});

test("asterisks in prose are escaped", () => {
  assert.equal(md("<p>2 * 3 = 6</p>"), "2 \\* 3 = 6");
});

test("nested lists", () => {
  const out = md("<ul><li>one<ul><li>nested</li></ul></li><li>two</li></ul>");
  assert.equal(out, "- one\n  - nested\n- two");
});

test("ordered lists with numbers", () => {
  const out = md("<ol><li>first</li><li>second</li></ol>");
  assert.equal(out, "1. first\n2. second");
});

test("code block with language", () => {
  const out = md('<pre><code class="language-js">const a = 1;</code></pre>');
  assert.equal(out, "```js\nconst a = 1;\n```");
});

test("code block content containing triple backticks uses a longer fence", () => {
  const out = md("<pre><code>a ``` b</code></pre>");
  assert.equal(out, "~~~~\na ``` b\n~~~~");
});

test("blockquote", () => {
  const out = md("<blockquote><p>line one</p><p>line two</p></blockquote>");
  assert.equal(out, "> line one\n>\n> line two");
});

test("table with header", () => {
  const out = md("<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>");
  assert.equal(out, "| A | B |\n| --- | --- |\n| 1 | 2 |");
});

test("table cells escape pipes", () => {
  const out = md("<table><tr><td>a|b</td><td>c</td></tr></table>");
  assert.equal(out, "| a\\|b | c |\n| --- | --- |");
});

test("hr", () => {
  assert.equal(md("<p>a</p><hr><p>b</p>"), "a\n\n---\n\nb");
});

test("images: off by default, on with includeImages", () => {
  const html = '<p><img src="https://x/i.png" alt="pic"></p>';
  assert.equal(md(html), "");
  assert.equal(md(html, { includeImages: true }), "![pic](https://x/i.png)");
});

test("data: images dropped", () => {
  const html = '<p><img src="data:image/png;base64,AAAA" alt="x"></p>';
  assert.equal(md(html, { includeImages: true }), "");
});

test("whitespace collapse and trimming", () => {
  const out = md("<div>  <p>a\n   b</p>   <p>c</p>  </div>");
  assert.equal(out, "a b\n\nc");
});

test("treeToText strips markdown syntax", () => {
  const tree = stripBoilerplate(buildTree(tokenize(
    "<body><h1>Title</h1><p>Some <b>bold</b> text with a <a href='https://x'>link</a>.</p><ul><li>item</li></ul></body>",
  )));
  const text = treeToText(tree);
  assert.equal(text, "Title\n\nSome bold text with a link.\n\nitem");
});

test("br renders as newline in markdown, space in text", () => {
  assert.equal(md("<p>a<br>b</p>"), "a\nb");
  const tree = stripBoilerplate(buildTree(tokenize("<p>a<br>b</p>")));
  assert.equal(treeToText(tree), "a b");
});
