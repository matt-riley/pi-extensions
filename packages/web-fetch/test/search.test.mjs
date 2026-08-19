import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDdgSearchUrl,
  buildSearxngUrl,
  formatSearchResults,
  isDdgBlocked,
  isDdgHomepageRedirect,
  parseDdgResults,
  parseSearxngResults,
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
  assert.deepEqual(parseDdgResults(""), { results: [], blocked: false, parseFailed: false });
  assert.deepEqual(parseDdgResults(null), { results: [], blocked: false, parseFailed: false });
  const { results, parseFailed } = parseDdgResults("<html><div>garbage <b>unclosed", { limit: 5 });
  assert.deepEqual(results, []);
  // Too short to be "substantial" — not flagged as bit-rot, just malformed/empty input.
  assert.equal(parseFailed, false);
  // A page with zero result bodies yields no results, not a crash.
  const { results: none, parseFailed: noneParseFailed } = parseDdgResults(
    "<html><body><div id='links'>No more results.</div></body></html>",
  );
  assert.deepEqual(none, []);
  assert.equal(noneParseFailed, false);
});

// A realistic-sized genuine "no results" DDG page: DDG branding, explicit
// no-results copy, but (like the real thing) no result__body blocks at all.
// Padded with representative chrome/boilerplate to cross the "substantial"
// length threshold, exercising that a real empty result set does NOT trip
// parseFailed.
const NO_RESULTS_FIXTURE = `<!DOCTYPE html>
<html><head><title>zzzxqvvnotarealquery123 at DuckDuckGo</title>
<meta name="generator" content="DuckDuckGo">
</head>
<body class="body--html no-results">
  <div id="header_wrapper">
    <div id="header" class="header--html">
      <div class="header__logo-wrap"><a href="https://duckduckgo.com/" class="header__logo">DuckDuckGo</a></div>
      <form id="search_form_homepage" action="/html/">
        <input type="text" name="q" value="zzzxqvvnotarealquery123">
      </form>
    </div>
  </div>
  <div id="links" class="results">
    <div class="no-results">
      <div class="result-snippet">
        No  results found for <b>zzzxqvvnotarealquery123</b>.<br>
        Try entering fewer or more general search terms.
      </div>
    </div>
  </div>
  <div id="bottom_spacing2"></div>
  <div class="serp__bottom-links">
    <a href="/html/?q=zzzxqvvnotarealquery123&kd=-1">Boost</a>
    <a href="https://duckduckgo.com/">DuckDuckGo Home</a>
  </div>
  <div id="footer">
    <a href="https://duckduckgo.com/about">About DuckDuckGo</a>
    <a href="https://duckduckgo.com/privacy">Privacy</a>
  </div>
</body></html>`;

// A page that still carries DDG branding/chrome (so it's clearly a real DDG
// response, not garbage) but whose result markup has been restructured away
// from result__body/result__a/result__snippet entirely — simulating DDG
// shipping a markup change that silently breaks this parser. No no-results
// copy is present, distinguishing this from a genuine empty result set.
const BITROT_FIXTURE = `<!DOCTYPE html>
<html><head><title>pi coding agent at DuckDuckGo</title>
<meta name="generator" content="DuckDuckGo">
</head>
<body class="body--html">
  <div id="header_wrapper">
    <div id="header" class="header--html">
      <div class="header__logo-wrap"><a href="https://duckduckgo.com/" class="header__logo">DuckDuckGo</a></div>
    </div>
  </div>
  <div id="links" class="react-results--main">
    <article class="react-result">
      <a class="react-result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fpi.dev%2F">Pi Coding Agent</a>
      <p class="react-result__snippet">A terminal-based coding agent &amp; harness.</p>
    </article>
    <article class="react-result">
      <a class="react-result__a" href="https://example.com/direct">Direct link result</a>
      <p class="react-result__snippet">Restructured markup, old selectors miss it.</p>
    </article>
  </div>
  <div id="footer">
    <a href="https://duckduckgo.com/about">About DuckDuckGo</a>
    <a href="https://duckduckgo.com/privacy">Privacy</a>
  </div>
</body></html>`;

test("parseDdgResults: parseFailed is false for a genuine no-results DDG page", () => {
  const { results, parseFailed } = parseDdgResults(NO_RESULTS_FIXTURE, { limit: 5 });
  assert.deepEqual(results, []);
  assert.equal(parseFailed, false);
});

test("parseDdgResults: parseFailed is true when DDG markup no longer matches the parser", () => {
  const { results, parseFailed } = parseDdgResults(BITROT_FIXTURE, { limit: 5 });
  assert.deepEqual(results, []);
  assert.equal(parseFailed, true);
});

test("parseDdgResults: parseFailed is false when results were extracted normally", () => {
  const { parseFailed } = parseDdgResults(FIXTURE, { limit: 10 });
  assert.equal(parseFailed, false);
});

const AD_FIXTURE = `<!DOCTYPE html>
<html><body>
  <div id="links" class="results">
    <div class="result results_links results_links_deep result--ad ">
      <div class="links_main links_deep result__body">
        <h2 class="result__title">
          <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fy.js%3Fad_domain%3Duswitch.com%26ad_provider%3Dbingv7aa&amp;rut=abc">Cheap Car Insurance</a>
        </h2>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fduckduckgo.com%2Fy.js%3Fad_domain%3Duswitch.com&amp;rut=abc">Sponsored ad snippet.</a>
      </div>
    </div>
    <div class="result results_links results_links_deep web-result ">
      <div class="links_main links_deep result__body">
        <h2 class="result__title">
          <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fpi.dev%2F&amp;rut=xyz">Pi Coding Agent</a>
        </h2>
        <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fpi.dev%2F&amp;rut=xyz">Organic snippet.</a>
      </div>
    </div>
  </div>
</body></html>`;

test("parseDdgResults: skips result--ad blocks", () => {
  const { results } = parseDdgResults(AD_FIXTURE, { limit: 10 });
  assert.equal(results.length, 1);
  assert.equal(results[0].title, "Pi Coding Agent");
  assert.equal(results[0].url, "https://pi.dev/");
});

test("parseDdgResults: skips results whose decoded URL stays on duckduckgo.com", () => {
  // No result--ad class on the wrapper, but the link is still a DDG tracker
  // (belt-and-braces: catches ad markup changes).
  const sneaky = AD_FIXTURE.replace("result--ad ", "");
  const { results } = parseDdgResults(sneaky, { limit: 10 });
  assert.equal(results.length, 1);
  assert.equal(results[0].title, "Pi Coding Agent");
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

test("isDdgHomepageRedirect: DDG bounce without a q= param", () => {
  assert.equal(isDdgHomepageRedirect("https://duckduckgo.com/"), true);
  assert.equal(isDdgHomepageRedirect("https://html.duckduckgo.com/"), true);
  assert.equal(isDdgHomepageRedirect("https://duckduckgo.com/?q=test"), false);
  assert.equal(isDdgHomepageRedirect("https://html.duckduckgo.com/html/?q=test"), false);
  assert.equal(isDdgHomepageRedirect("https://example.com/"), false);
  assert.equal(isDdgHomepageRedirect(""), false);
  assert.equal(isDdgHomepageRedirect("not a url"), false);
});

test("buildSearxngUrl: JSON API params on the user's instance", () => {
  assert.equal(
    buildSearxngUrl("https://searxng.example.com", "pi coding agent"),
    "https://searxng.example.com/search?q=pi+coding+agent&format=json&pageno=1&safesearch=0",
  );
  // An explicit /search path is kept.
  assert.equal(
    buildSearxngUrl("https://searxng.example.com/search?foo=1", "x"),
    "https://searxng.example.com/search?foo=1&q=x&format=json&pageno=1&safesearch=0",
  );
  // A reverse-proxy base path (tailnet serve) gets /search appended.
  assert.equal(
    buildSearxngUrl("https://waffle.example/searxng", "x"),
    "https://waffle.example/searxng/search?q=x&format=json&pageno=1&safesearch=0",
  );
  assert.throws(() => buildSearxngUrl("not a url", "q"), TypeError);
});

const SEARXNG_JSON = JSON.stringify({
  query: "pi coding agent",
  number_of_results: 2,
  results: [
    { title: "Pi Coding Agent", url: "https://pi.dev/", content: "A terminal-based <b>coding</b> agent.", engine: "duckduckgo" },
    { title: "Docs", url: "https://pi.dev/docs/latest", content: "Extensions, skills, and themes." },
    { title: "No URL entry", content: "skipped" },
    { title: "", url: "https://empty-title.example", content: "skipped" },
  ],
});

test("parseSearxngResults: extracts results and caps the limit", () => {
  const { results, error } = parseSearxngResults(SEARXNG_JSON, { limit: 10 });
  assert.equal(error, undefined);
  assert.equal(results.length, 2); // entries without url/title are skipped
  assert.deepEqual(results[0], {
    title: "Pi Coding Agent",
    url: "https://pi.dev/",
    snippet: "A terminal-based <b>coding</b> agent.",
  });
  const capped = parseSearxngResults(SEARXNG_JSON, { limit: 1 });
  assert.equal(capped.results.length, 1);
});

test("parseSearxngResults: error responses and non-JSON bodies", () => {
  assert.match(parseSearxngResults(JSON.stringify({ error: "Invalid request" })).error, /SearXNG: Invalid request/);
  assert.match(parseSearxngResults("<html>rate limited</html>").error, /non-JSON/);
  assert.match(parseSearxngResults("").error, /non-JSON/);
  assert.deepEqual(parseSearxngResults(JSON.stringify({ results: null })), { results: [] });
});

test("formatSearchResults: blocked / redirected / empty / results", () => {
  const blocked = formatSearchResults({ query: "x", results: [], blocked: true });
  assert.match(blocked, /blocked by DuckDuckGo/);

  const redirected = formatSearchResults({ query: "x", results: [], redirected: true });
  assert.match(redirected, /homepage instead of results/);

  const parseFailed = formatSearchResults({ query: "x", results: [], parseFailed: true });
  assert.match(parseFailed, /markup could not be parsed/);
  assert.match(parseFailed, /SearXNG/);

  assert.equal(formatSearchResults({ query: "zzz", results: [] }), 'No results found for "zzz".');

  const { results } = parseDdgResults(FIXTURE, { limit: 10 });
  const text = formatSearchResults({ query: "pi coding agent", results, limit: 5 });
  assert.match(text, /^Search results for "pi coding agent" \(2\) — DuckDuckGo/);
  assert.match(text, /1\. \[Pi Coding Agent\]\(https:\/\/pi\.dev\/\)/);
  assert.match(text, /A terminal-based coding agent & harness\./);
});

test("formatSearchResults: marks the cap and labels the engine", () => {
  const { results } = parseDdgResults(FIXTURE, { limit: 1 });
  const text = formatSearchResults({ query: "q", results, limit: 1 });
  assert.match(text, /\(1\+\)/);

  const searxng = formatSearchResults({ query: "q", results, limit: 1, engine: "SearXNG" });
  assert.match(searxng, /— SearXNG/);
  const blockedSearxng = formatSearchResults({ query: "q", results: [], blocked: true, engine: "SearXNG" });
  assert.match(blockedSearxng, /blocked by SearXNG/);
});
