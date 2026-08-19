import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDdgSearchUrl,
  formatDdgResults,
  isDdgBlocked,
  parseDdgResults,
} from "../search.mjs";

// Faithful slice of real html.duckduckgo.com markup (captured 2026-08-19):
// multi-class result__body div, result__a title link wrapped in a uddg=
// redirect, result__url display link, result__snippet with <b> tags and
// entities, plus a direct (non-wrapped) result link.
const FIXTURE = `<!DOCTYPE html>
<html><head><title>pi coding agent at DuckDuckGo</title></head>
<body>
  <div id="links" class="results">
    <div class="result results_links results_links_deep web-result ">
      <div class="links_main links_deep result__body">
        <h2 class="result__title">
          <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fpi.dev%2F&amp;rut=45614ef7196210e3c532f21c51de417367205edb9042ede1b4cf3ebfb97724be">Pi Coding Agent</a>
        </h2>
        <div class="result__extras">
          <div class="result__extras__url">
            <a class="result__url" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fpi.dev%2F&amp;rut=45614ef7196210e3c532f21c51de417367205edb9042ede1b4cf3ebfb97724be">pi.dev</a>
          </div>
        </div>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fpi.dev%2F&amp;rut=45614ef7196210e3c532f21c51de417367205edb9042ede1b4cf3ebfb97724be">A terminal-based <b>coding</b> <b>agent</b> &amp; harness.</a>
        <div class="clear"></div>
      </div>
    </div>
    <div class="result results_links results_links_deep web-result ">
      <div class="links_main links_deep result__body">
        <h2 class="result__title">
          <a rel="nofollow" class="result__a" href="https://example.com/direct">Direct link result &#x27;quoted&#x27;</a>
        </h2>
        <a class="result__snippet" href="https://example.com/direct">Plain <b>absolute</b> href, no wrapper.</a>
      </div>
    </div>
  </div>
</body></html>`;

test("buildDdgSearchUrl: encodes the query and appends region", () => {
  assert.equal(buildDdgSearchUrl("pi coding agent"), "https://html.duckduckgo.com/html/?q=pi+coding+agent");
  assert.equal(
    buildDdgSearchUrl("hello", { region: "us-en" }),
    "https://html.duckduckgo.com/html/?q=hello&kl=us-en",
  );
});

test("parseDdgResults: extracts titles, decoded urls, and cleaned snippets", () => {
  const { results, blocked } = parseDdgResults(FIXTURE, { limit: 10 });
  assert.equal(blocked, false);
  assert.equal(results.length, 2);

  const [first, second] = results;
  // Title comes from result__a, not the result__url display text ("pi.dev").
  assert.equal(first.title, "Pi Coding Agent");
  // uddg= wrapper decoded to the real destination, rut= dropped.
  assert.equal(first.url, "https://pi.dev/");
  // <b> tags stripped, entities decoded, whitespace collapsed.
  assert.equal(first.snippet, "A terminal-based coding agent & harness.");

  // Direct (non-wrapped) hrefs are kept as-is; numeric entities decode.
  assert.equal(second.title, "Direct link result 'quoted'");
  assert.equal(second.url, "https://example.com/direct");
  assert.equal(second.snippet, "Plain absolute href, no wrapper.");
});

test("parseDdgResults: enforces the limit", () => {
  const { results } = parseDdgResults(FIXTURE, { limit: 1 });
  assert.equal(results.length, 1);
  assert.equal(results[0].title, "Pi Coding Agent");
});

test("parseDdgResults: tolerant of missing/empty/malformed input", () => {
  assert.deepEqual(parseDdgResults(""), { results: [], blocked: false });
  assert.deepEqual(parseDdgResults(null), { results: [], blocked: false });
  const { results } = parseDdgResults("<html><div>garbage <b>unclosed", { limit: 5 });
  assert.deepEqual(results, []);
  // A page with zero result bodies yields no results, not a crash.
  const { results: none } = parseDdgResults(
    "<html><body><div id='links'>No more results.</div></body></html>",
  );
  assert.deepEqual(none, []);
});

test("isDdgBlocked: challenge markers and status 202", () => {
  assert.equal(isDdgBlocked({ status: 202 }), true);
  assert.equal(isDdgBlocked({ status: 200, body: "<script src='/anomaly.js'></script>" }), true);
  assert.equal(isDdgBlocked({ status: 200, body: "jschallenge detect" }), true);
  assert.equal(isDdgBlocked({ status: 200, body: "We've detected unusual traffic from your computer network." }), true);
  // The bare word "anomaly" in results text is NOT a challenge marker.
  assert.equal(isDdgBlocked({ status: 200, body: FIXTURE }), false);
  assert.equal(isDdgBlocked({ status: 200, body: "" }), false);
});

test("formatDdgResults: blocked / empty / results", () => {
  const blocked = formatDdgResults({ query: "x", results: [], blocked: true });
  assert.match(blocked, /blocked by DuckDuckGo/);

  assert.equal(formatDdgResults({ query: "zzz", results: [] }), 'No results found for "zzz".');

  const { results } = parseDdgResults(FIXTURE, { limit: 10 });
  const text = formatDdgResults({ query: "pi coding agent", results, limit: 5 });
  assert.match(text, /^Search results for "pi coding agent" \(2\) — DuckDuckGo/);
  assert.match(text, /1\. \[Pi Coding Agent\]\(https:\/\/pi\.dev\/\)/);
  assert.match(text, /A terminal-based coding agent & harness\./);
});

test("formatDdgResults: marks the cap when the limit was reached", () => {
  const { results } = parseDdgResults(FIXTURE, { limit: 1 });
  const text = formatDdgResults({ query: "q", results, limit: 1 });
  assert.match(text, /\(1\+\)/);
});
