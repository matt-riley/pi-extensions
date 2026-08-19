import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildTree,
  decodeEntities,
  extractMetadata,
  selectMain,
  serializeTree,
  stripBoilerplate,
  textLength,
  tokenize,
} from "../html.mjs";

// --- tokenizer --------------------------------------------------------------

test("tokenize: tags and text", () => {
  const tokens = tokenize("<div><p>Hello</p> world</div>");
  assert.deepEqual(
    tokens.map((t) => t.type),
    ["tag", "tag", "text", "close", "text", "close"],
  );
  assert.equal(tokens[2].text, "Hello");
  assert.equal(tokens[4].text, " world");
});

test("tokenize: attribute forms", () => {
  const [tag] = tokenize('<a href="https://x" data-a=\'y\' unquoted=z hidden>');
  assert.equal(tag.type, "tag");
  assert.deepEqual(tag.attrs, [
    { name: "href", value: "https://x" },
    { name: "data-a", value: "y" },
    { name: "unquoted", value: "z" },
    { name: "hidden", value: "" },
  ]);
});

test("tokenize: self-closing and void elements", () => {
  const tokens = tokenize("<br/><img src=\"a.png\"><hr>");
  assert.deepEqual(
    tokens.map((t) => t.type),
    ["tag", "tag", "tag"],
  );
  assert.equal(tokens[0].selfClosing, true);
  assert.equal(tokens[1].name, "img");
});

test("tokenize: comments and doctype dropped", () => {
  const tokens = tokenize("<!DOCTYPE html><!-- hi --><p>x</p>");
  assert.equal(tokens.filter((t) => t.type === "tag").length, 1);
});

test("tokenize: script/style raw bodies dropped", () => {
  const tokens = tokenize("<script>var a = 1 < 2;</script><style>.x{}</style><p>ok</p>");
  const tags = tokens.filter((t) => t.type === "tag").map((t) => t.name);
  assert.deepEqual(tags, ["script", "style", "p"]);
});

test("tokenize: entities decoded in text and attributes", () => {
  const [text] = tokenize("a &amp; b &lt;tag&gt; &#65; &#x42;");
  assert.equal(text.text, "a & b <tag> A B");
  const [tag] = tokenize('<a title="x &quot;y&quot;">');
  assert.equal(tag.attrs[0].value, 'x "y"');
});

test("tokenize: bare < stays text", () => {
  const tokens = tokenize("1 < 2 and a>b");
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].text, "1 < 2 and a>b");
});

test("tokenize: CDATA kept as text", () => {
  const tokens = tokenize("<![CDATA[raw & stuff]]>tail");
  assert.deepEqual(
    tokens.map((t) => t.text),
    ["raw & stuff", "tail"],
  );
});

test("tokenize: malformed close tag treated as text", () => {
  const tokens = tokenize("</ nope>");
  assert.equal(tokens.length, 1);
});

// --- tree builder -----------------------------------------------------------

test("buildTree: nesting", () => {
  const tree = buildTree(tokenize("<div><p>a</p><p>b</p></div>"));
  assert.equal(tree.children.length, 1);
  const div = tree.children[0];
  assert.equal(div.tag, "div");
  assert.equal(div.children.length, 2);
  assert.equal(textLength(div), 2);
});

test("buildTree: p auto-closes on block elements", () => {
  const tree = buildTree(tokenize("<p>a<div>b</div></p>"));
  const p = tree.children[0];
  const div = tree.children[1];
  assert.equal(p.tag, "p");
  assert.equal(div.tag, "div");
  assert.equal(p.children.length, 1); // "a" only
});

test("buildTree: li closes li, tr closes td", () => {
  const tree = buildTree(tokenize("<ul><li>a<li>b</ul>"));
  assert.equal(tree.children[0].children.length, 2);
  const table = buildTree(tokenize("<table><tr><td>a<td>b<tr><td>c</table>"));
  const rows = table.children[0].children.filter((n) => n.tag === "tr");
  assert.equal(rows.length, 2);
});

test("buildTree: same-name div guard", () => {
  const tree = buildTree(tokenize("<div>a<div>b</div>"));
  const top = tree.children.filter((n) => n.tag === "div");
  assert.equal(top.length, 2); // second div becomes a sibling, no deep chain
});

test("buildTree: stray close tag ignored", () => {
  const tree = buildTree(tokenize("<p>a</span></p><p>b</p>"));
  assert.equal(tree.children.filter((n) => n.tag === "p").length, 2);
});

test("buildTree: depth cap does not throw", () => {
  const deep = "<div>".repeat(500) + "x" + "</div>".repeat(500);
  const tree = buildTree(tokenize(deep));
  assert.ok(tree.children.length > 0);
});

// --- boilerplate ------------------------------------------------------------

function treeFrom(html) {
  return buildTree(tokenize(html));
}

test("stripBoilerplate: removes chrome tags", () => {
  const tree = stripBoilerplate(treeFrom(
    "<body><nav>menu</nav><footer>foot</footer><aside>side</aside>" +
    "<form><input></form><script>x</script><style>y</style>" +
    "<main><p>content</p></main></body>",
  ));
  const tags = [];
  const walk = (n) => { if (n.tag) tags.push(n.tag); for (const c of n.children) walk(c); };
  walk(tree);
  assert.ok(!tags.includes("nav"));
  assert.ok(!tags.includes("footer"));
  assert.ok(!tags.includes("aside"));
  assert.ok(!tags.includes("form"));
  assert.ok(tags.includes("main"));
});

test("stripBoilerplate: class/id heuristics", () => {
  const tree = stripBoilerplate(treeFrom(
    '<body><div class="sidebar">x</div><div id="comments">y</div>' +
    '<div class="ad-container">z</div><div class="article-body">keep</div></body>',
  ));
  const texts = [];
  const walk = (n) => {
    if (n.tag === null && n.children.length === 0) texts.push(n.text);
    for (const c of n.children) walk(c);
  };
  walk(tree);
  assert.equal(texts.join(" ").trim(), "keep");
});

test("stripBoilerplate: hidden dropped, article header kept", () => {
  const tree = stripBoilerplate(treeFrom(
    '<body><header class="site-header">site</header>' +
    '<article><header><h1>Title</h1></header><p hidden>secret</p><p>body</p></article></body>',
  ));
  const texts = [];
  const walk = (n) => { if (n.tag === null) texts.push(n.text); for (const c of n.children) walk(c); };
  walk(tree);
  assert.ok(!texts.includes("secret"));
  assert.ok(!texts.includes("site"));
  assert.ok(texts.includes("Title"));
});

test("stripBoilerplate: prunes empty containers", () => {
  const tree = stripBoilerplate(treeFrom("<body><div><nav>x</nav></div><p>keep</p></body>"));
  const divs = [];
  const walk = (n) => { if (n.tag === "div") divs.push(n); for (const c of n.children) walk(c); };
  walk(tree);
  assert.equal(divs.length, 0);
});

// --- main selection ---------------------------------------------------------

test("selectMain: article preferred over more text elsewhere", () => {
  const tree = stripBoilerplate(treeFrom(
    "<body><div>".repeat(1) + "long padding text ".repeat(40) +
    "<article><p>short real content</p></article></div></body>",
  ));
  const main = selectMain(tree);
  assert.equal(main.tag, "article");
});

test("selectMain: main/role=main", () => {
  const tree = stripBoilerplate(treeFrom(
    '<body><div role="main"><p>content here</p></div></body>',
  ));
  const main = selectMain(tree);
  assert.equal(main.attrs.role, "main");
});

test("selectMain: longest block child wins", () => {
  const tree = stripBoilerplate(treeFrom(
    "<body><div><p>short</p></div><div><p>".concat("words ".repeat(60), "</p></div></body>"),
  ));
  const main = selectMain(tree);
  assert.ok(textLength(main) > 200);
});

test("selectMain: falls back to body for short pages", () => {
  const tree = stripBoilerplate(treeFrom("<body><h1>Hi</h1><p>short page</p></body>"));
  const main = selectMain(tree);
  assert.ok(main);
  assert.ok(textLength(main) < 200);
});

// --- serialization ----------------------------------------------------------

test("serializeTree: pretty-printed cleaned html", () => {
  const tree = stripBoilerplate(treeFrom("<body><main><h1>T</h1><p>Hello <b>world</b></p><pre>  keep\n  me</pre></main></body>"));
  const html = serializeTree(selectMain(tree));
  assert.match(html, /<h1>T<\/h1>/);
  assert.match(html, /Hello <b>world<\/b>/);
  assert.match(html, /  keep\n  me/); // pre whitespace preserved
});

// --- metadata ---------------------------------------------------------------

test("extractMetadata: full head", () => {
  const html =
    '<!DOCTYPE html><html lang="en-GB"><head>' +
    "<title>My Page &amp; More</title>" +
    '<meta name="description" content="A great page">' +
    '<meta name="author" content="Jane Doe">' +
    '<meta property="og:site_name" content="Example">' +
    '<meta property="article:published_time" content="2026-08-19T10:00:00Z">' +
    '<link rel="canonical" href="https://example.com/page">' +
    "</head><body><p>x</p></body></html>";
  const meta = extractMetadata(html);
  assert.equal(meta.title, "My Page & More");
  assert.equal(meta.description, "A great page");
  assert.equal(meta.author, "Jane Doe");
  assert.equal(meta.siteName, "Example");
  assert.equal(meta.published, "2026-08-19T10:00:00Z");
  assert.equal(meta.lang, "en-gb");
  assert.equal(meta.canonical, "https://example.com/page");
});

test("extractMetadata: og:title and time datetime fallbacks", () => {
  const html =
    '<html><head><meta property="og:title" content="OG Title">' +
    "<time datetime=\"2025-01-02\"></time></head><body></body></html>";
  const meta = extractMetadata(html);
  assert.equal(meta.title, "OG Title");
  assert.equal(meta.published, "2025-01-02");
});

test("decodeEntities: unknown entities pass through", () => {
  assert.equal(decodeEntities("&bogus; &amp;"), "&bogus; &");
});
