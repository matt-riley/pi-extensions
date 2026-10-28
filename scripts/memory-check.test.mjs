import assert from "node:assert/strict";
import test from "node:test";

import {
  RELATIONS,
  buildQuestions,
  checkMemory,
  formatCheck,
  parseSearchOutput,
  rankCandidates,
  recommendation,
  routeCheck,
  searchLore,
  searchQueries,
  similarity,
  tokens,
} from "./memory-check.mjs";

const noul = (value) => ({ type: "noul", noul: value });
const choice = (value, confidence = 0.8) => ({
  type: "choice",
  choice: value,
  confidence,
  probabilities: { [value]: confidence },
});

const ITEMS = [
  {
    id: "a",
    content: "Cloudflare MCP tools stay deferred: they are absent from the prompt but callable.",
    kind: "commitment",
  },
  { id: "b", content: "Use pnpm, never npm, in this repository.", kind: "user_preference" },
];

test("overlap counts content words, not stop words", () => {
  assert.ok(!tokens("the and of it").has("the"));
  assert.equal(similarity("use pnpm in this repo", "use pnpm in this repo"), 1);
  assert.ok(similarity("pnpm repository preference", "pnpm repository preference again") > 0.5);
  assert.equal(similarity("pnpm", "cloudflare"), 0);
});

test("the search payload is unwrapped whatever the CLI returned", () => {
  assert.equal(parseSearchOutput(JSON.stringify({ result: { items: ITEMS } })).length, 2);
  assert.equal(parseSearchOutput(JSON.stringify({ items: ITEMS })).length, 2);
  assert.equal(parseSearchOutput(JSON.stringify(ITEMS)).length, 2);
  assert.deepEqual(parseSearchOutput("{}"), []);
  assert.deepEqual(parseSearchOutput(JSON.stringify([{ id: "x" }])), []);
});

test("only the closest candidates reach the model", () => {
  const ranked = rankCandidates("Cloudflare MCP tools deferred", ITEMS, { limit: 1 });
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].id, "a");
  assert.ok(ranked[0].similarity > 0);
});

test("the relation is asked once, each candidate separately", () => {
  const questions = buildQuestions(2);
  assert.deepEqual(Object.keys(questions).sort(), ["relation", "same_0", "same_1"]);
  assert.match(questions.same_1.instructions, /`candidates\.1\.content`/);
});

test("a relation outside the set is not a check", () => {
  assert.equal(routeCheck({ relation: choice("vibes") }, ITEMS).relation, null);
  assert.equal(routeCheck({}, ITEMS).relation, null);
});

test("only matching memories are named, and only when the relation is actionable", () => {
  const duplicate = routeCheck(
    { relation: choice("duplicate"), same_0: noul(0.9), same_1: noul(0.1) },
    ITEMS,
  );
  assert.equal(duplicate.matches.length, 1);
  assert.equal(duplicate.matches[0].id, "a");
  assert.equal(routeCheck({ relation: choice("new"), same_0: noul(0.9) }, ITEMS).matches.length, 0);
});

test("the recommendation names the memory to update", () => {
  const matches = [{ id: "a", probability: 0.9 }];
  assert.match(recommendation({ relation: "duplicate", matches }), /Update a instead/);
  assert.match(recommendation({ relation: "contradiction", matches }), /Conflicts with a/);
  assert.match(recommendation({ relation: "refinement", matches }), /Amend a/);
  assert.match(recommendation({ relation: "new" }), /save as new/);
  assert.match(recommendation({ relation: "duplicate", matches: [] }), /lore_search/);
});

test("the report shows the distribution, the match and what to do", () => {
  const result = routeCheck(
    { relation: choice("duplicate", 0.87), same_0: noul(0.91), same_1: noul(0.05) },
    ITEMS,
  );
  const text = formatCheck({ memory: "x", ...result, judged: true });
  assert.match(text, /^relation: duplicate \(confidence 0\.87\)/);
  assert.match(text, /duplicate 0\.87/);
  assert.match(text, /a · commitment · 0\.91 — Cloudflare MCP/);
  assert.match(text, /→ Update a instead/);
  assert.match(formatCheck({ judged: false, reason: "no key" }), /^Not checked: no key/);
});

test("the search asks across repositories and says which one when told", () => {
  const calls = [];
  const exec = (bin, args) => {
    calls.push([bin, args]);
    return JSON.stringify({ result: { items: ITEMS } });
  };
  searchLore({ query: "cloudflare", exec });
  assert.equal(calls[0][0], "lore");
  assert.ok(calls[0][1].includes("--all-repositories"));
  searchLore({ query: "cloudflare", repository: "pi", exec });
  assert.deepEqual(calls[1][1].slice(-2), ["--repository", "pi"]);
});

test("the query is the memory's distinctive words, never the whole sentence", () => {
  const queries = searchQueries(
    "Cloudflare MCP tools stay deferred: they are not in the declared prompt but remain callable from codemode.",
  );
  assert.deepEqual(queries.length, 2);
  assert.doesNotMatch(queries[0], /:|\./);
  assert.equal(queries[0].split(" ").length, 6);
  assert.ok(queries[0].startsWith("cloudflare"));
  assert.equal(queries[1], "cloudflare");
  assert.deepEqual(searchQueries(""), []);
});

test("a query that finds nothing is retried broader, not read as novelty", async () => {
  const queries = [];
  const result = await checkMemory({
    memory: "Cloudflare MCP tools stay deferred.",
    env: {},
    exec: (_bin, args) => {
      queries.push(args[1]);
      return queries.length === 1
        ? JSON.stringify({ result: { items: [] } })
        : JSON.stringify({ result: { items: ITEMS } });
    },
    ask: async () => ({
      answers: { relation: choice("duplicate"), same_0: noul(0.9), same_1: noul(0.1) },
    }),
  });
  assert.equal(queries.length, 2);
  assert.notEqual(queries[0], queries[1]);
  assert.equal(result.judged, true);
  assert.equal(result.relation, "duplicate");
});

test("the lexical half can be replaced, so a dead daemon is not a guess", async () => {
  let asked = false;
  const result = await checkMemory({
    memory: "Cloudflare MCP tools stay deferred.",
    exec: () => {
      throw new Error("connect ENOENT /Users/x/.lore/lored.sock");
    },
    ask: async () => {
      asked = true;
    },
  });
  assert.equal(asked, false);
  assert.equal(result.judged, false);
  assert.match(result.reason, /ENOENT/);
});

test("an empty store is reported, not judged", async () => {
  const result = await checkMemory({ memory: "something new", candidates: [], env: {} });
  assert.equal(result.judged, false);
  assert.match(result.reason, /no memories/);
});

test("a judged duplicate comes back with the memory to update", async () => {
  const calls = [];
  const result = await checkMemory({
    memory: "Cloudflare MCP tools stay deferred.",
    candidates: ITEMS,
    env: {},
    ask: async (request) => {
      calls.push(request);
      return {
        model: "test",
        answers: { relation: choice("duplicate"), same_0: noul(0.93), same_1: noul(0.02) },
      };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].state.candidates.length, 2);
  assert.equal(result.judged, true);
  assert.equal(result.relation, "duplicate");
  assert.equal(result.matches[0].id, "a");
  assert.match(formatCheck(result), /Update a instead/);
});

test("a failed request is reported, never treated as novelty", async () => {
  const result = await checkMemory({
    memory: "anything",
    candidates: ITEMS,
    env: {},
    ask: async () => {
      throw new Error("TYPESAFE_API_KEY is not set");
    },
  });
  assert.equal(result.judged, false);
  assert.match(result.reason, /TYPESAFE_API_KEY/);
});

test("the relations are four and each is a distinct action", () => {
  assert.deepEqual(Object.keys(RELATIONS), ["duplicate", "contradiction", "refinement", "new"]);
});
