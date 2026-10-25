import assert from "node:assert/strict";
import test from "node:test";

import { formatBatchResult, formatWebFetchResult, isKnownFormat } from "../format.mjs";

const page = {
  kind: "page",
  finalUrl: "https://example.com/a",
  title: "A page",
  author: "Ada",
  status: 404,
  via: "gh",
  markdown: "# Body",
  text: "Body",
  html: "<h1>Body</h1>",
};

test("isKnownFormat accepts the five formats and nothing else", () => {
  for (const f of ["markdown", "html", "text", "json", "raw"]) assert.equal(isKnownFormat(f), true);
  assert.equal(isKnownFormat("xml"), false);
  assert.equal(isKnownFormat(undefined), false);
});

test("a page leads with the metadata that is present, and flags a non-200 status", () => {
  const out = formatWebFetchResult(page);
  assert.equal(
    out,
    "title: A page\nurl: https://example.com/a\nauthor: Ada\nstatus: HTTP 404\nvia: gh\n\n# Body",
  );
  assert.ok(!formatWebFetchResult({ ...page, status: 200 }).includes("status:"));
});

test("a page renders the requested body, falling back to markdown when html is empty", () => {
  assert.ok(formatWebFetchResult(page, { format: "text" }).endsWith("\n\nBody"));
  assert.ok(formatWebFetchResult(page, { format: "html" }).endsWith("<h1>Body</h1>"));
  assert.ok(formatWebFetchResult({ ...page, html: "" }, { format: "html" }).endsWith("# Body"));
});

test("a truncated page says where it stopped and how to get more", () => {
  const out = formatWebFetchResult({ ...page, truncated: true }, { maxChars: 500 });
  assert.ok(out.endsWith("[content truncated at 500 chars — raise maxChars for more]"));
});

test("json format is a single parseable document, capped to the limit", () => {
  const parsed = JSON.parse(formatWebFetchResult(page, { format: "json" }));
  assert.equal(parsed.url, "https://example.com/a");
  assert.equal(parsed.content, "# Body");
  const capped = formatWebFetchResult(
    { ...page, markdown: "x".repeat(5000) },
    { format: "json", maxChars: 200 },
  );
  assert.ok(capped.length < 600);
});

test("a text payload is fenced as code in markdown unless it is already prose", () => {
  const code = { kind: "text", mime: "application/javascript", text: "let a = 1;" };
  assert.equal(formatWebFetchResult(code), "```\nlet a = 1;\n```");
  assert.equal(
    formatWebFetchResult({ ...code, text: "a ``` b" }),
    "~~~~\na ``` b\n~~~~",
    "a fence inside the text must not close the outer one",
  );
  assert.equal(formatWebFetchResult({ ...code, mime: "text/plain" }), "let a = 1;");
  assert.equal(formatWebFetchResult(code, { format: "text" }), "let a = 1;");
  assert.ok(formatWebFetchResult({ ...code, truncated: true }).endsWith("\n\n[truncated]"));
});

test("a json text payload is pretty-printed, and invalid json is passed through", () => {
  const json = { kind: "text", mime: "application/json", text: '{"a":1}' };
  assert.equal(formatWebFetchResult(json, { format: "json" }), '{\n  "a": 1\n}');
  assert.equal(formatWebFetchResult({ ...json, text: "{oops" }, { format: "json" }), "{oops");
});

test("raw output notes truncation with the limit that applied", () => {
  assert.equal(formatWebFetchResult({ kind: "raw", text: "abc" }), "abc");
  assert.ok(
    formatWebFetchResult({ kind: "raw", text: "abc", truncated: true }).endsWith(
      "[truncated at 200000 chars — raise maxChars for more]",
    ),
  );
});

test("a binary payload is declined with its size and a way forward", () => {
  const exact = formatWebFetchResult({
    kind: "binary",
    mime: "image/png",
    sizeHint: 12,
    finalUrl: "u",
  });
  assert.ok(exact.startsWith("Binary payload — not extracted (image/png, 12 bytes)."));
  assert.ok(exact.includes("URL: u"));
  assert.ok(formatWebFetchResult({ kind: "binary", probedBytes: 64 }).includes("≥ 64 bytes"));
  assert.ok(
    formatWebFetchResult({ kind: "binary" }).includes("unknown content-type, unknown size"),
  );
});

test("an unknown outcome kind is reported rather than thrown", () => {
  assert.equal(formatWebFetchResult({ kind: "mystery" }), "Unknown fetch result.");
});

test("a batch counts ok, failed and skipped, and labels each item", () => {
  const items = [
    { index: 0, request: { url: "https://a" }, outcome: { kind: "raw", text: "A" } },
    { index: 1, request: { url: "https://b" }, error: "timeout" },
    { index: 2, request: { url: "https://c" }, skipped: "duplicate" },
  ];
  assert.equal(
    formatBatchResult(items, { concurrency: 4 }),
    [
      "batch_web_fetch: 3 URLs — 1 ok, 1 failed, 1 skipped (concurrency 4)",
      "",
      "--- [1/3] OK https://a",
      "A",
      "",
      "--- [2/3] FAILED https://b",
      "timeout",
      "",
      "--- [3/3] SKIPPED https://c",
      "Skipped: duplicate",
    ].join("\n"),
  );
});
