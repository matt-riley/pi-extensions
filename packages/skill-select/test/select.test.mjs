import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TIEBREAK_ENV, selectSkills, tiebreakEnabled } from "../select.mjs";

const ENV = { [TIEBREAK_ENV]: "1", TYPESAFE_API_KEY: "tb-key" };
// Guaranteed-absent home and config path: the key-less cases must not read a
// real machine's lore config, or the suite passes and fails by environment.
const NO_KEY_HOME = join(tmpdir(), "pi-select-no-home");
const NO_KEY_ENV = { HOME: NO_KEY_HOME, LORE_CONFIG: join(NO_KEY_HOME, "lore.json") };

const skill = (name, description = `${name} description`) => ({
  name,
  description,
  path: `/lib/${name}/SKILL.md`,
});

const LIBRARY = [
  skill("cloudflare", "Workers, KV, D1 and R2 on Cloudflare"),
  skill("git-signing-troubleshoot", "Fix blocked commits when GPG or SSH signing fails"),
  skill("web-perf", "Measure and improve page load performance"),
  skill("grill-me", "Stress-test a plan or design decision"),
];

function fakeAsk(probabilities, { choice } = {}) {
  const calls = [];
  const ask = async (request) => {
    calls.push(request);
    const best = choice ?? Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0][0];
    return { answers: { best: { type: "choice", choice: best, probabilities } } };
  };
  return { ask, calls };
}

test("tiebreakEnabled is on by default with a key and off on request", () => {
  assert.equal(tiebreakEnabled({ TYPESAFE_API_KEY: "k" }), true);
  assert.equal(tiebreakEnabled({ LORE_TYPESAFE_API_KEY: "k" }), true);
  assert.equal(tiebreakEnabled(NO_KEY_ENV), false);
  assert.equal(tiebreakEnabled({ [TIEBREAK_ENV]: "0", TYPESAFE_API_KEY: "k" }), false);
  assert.equal(tiebreakEnabled({ [TIEBREAK_ENV]: "off", TYPESAFE_API_KEY: "k" }), false);
});

test("a small library is shown whole, including skills lexical ranking cannot see", async () => {
  const { ask, calls } = fakeAsk({
    "git-signing-troubleshoot": 0.9,
    cloudflare: 0.05,
    none_of_these: 0.01,
  });
  const out = await selectSkills({
    skills: LIBRARY,
    query: "my pushes are refused because the key agent is missing",
    env: ENV,
    ask,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0].questions.best.criteria), [
    ...LIBRARY.map((entry) => entry.name),
    "none_of_these",
  ]);
  assert.equal(out.matches[0].name, "git-signing-troubleshoot"); // lexical score was 0
  assert.equal(out.matches[0].p, 0.9);
  assert.equal(out.note, null);
  assert.equal(out.reason, "wide");
});

test("orders by Jev's probabilities and honours the limit", async () => {
  const { ask } = fakeAsk({
    "web-perf": 0.6,
    cloudflare: 0.3,
    "grill-me": 0.05,
    none_of_these: 0.05,
  });
  const out = await selectSkills({
    skills: LIBRARY,
    query: "make it faster",
    limit: 2,
    env: ENV,
    ask,
  });
  assert.deepEqual(
    out.matches.map((m) => m.name),
    ["web-perf", "cloudflare"],
  );
});

test("says so when no skill fits, and keeps the candidates visible", async () => {
  const { ask } = fakeAsk({ none_of_these: 0.9, "web-perf": 0.1 });
  const out = await selectSkills({ skills: LIBRARY, query: "write a haiku", env: ENV, ask });
  assert.match(out.note, /no listed skill clearly fits.*0\.90/);
  assert.equal(out.matches[0].name, "web-perf");
});

test("all probability on none_of_these keeps the lexical matches and the note", async () => {
  const { ask } = fakeAsk({ none_of_these: 1 });
  const out = await selectSkills({ skills: LIBRARY, query: "cloudflare thanks", env: ENV, ask });
  assert.equal(out.reason, "declined");
  assert.match(out.note, /no listed skill clearly fits/);
  assert.equal(out.matches[0].name, "cloudflare");
});

test("without a distribution the chosen option still wins", async () => {
  const ask = async () => ({ answers: { best: { type: "choice", choice: "grill-me" } } });
  const out = await selectSkills({ skills: LIBRARY, query: "challenge my design", env: ENV, ask });
  assert.equal(out.matches[0].name, "grill-me");
});

test("no call when disabled or browsing; lexical order is returned", async () => {
  const { ask, calls } = fakeAsk({ cloudflare: 1 });
  const off = await selectSkills({ skills: LIBRARY, query: "cloudflare", env: NO_KEY_ENV, ask });
  const browse = await selectSkills({ skills: LIBRARY, query: "  ", env: ENV, ask });
  assert.equal(calls.length, 0);
  assert.equal(off.reason, "disabled");
  assert.equal(off.matches[0].name, "cloudflare");
  assert.equal(browse.reason, "no_query");
});

test("fails open on provider errors and unusable answers", async () => {
  const boom = await selectSkills({
    skills: LIBRARY,
    query: "cloudflare",
    env: ENV,
    ask: async () => {
      throw new Error("503");
    },
  });
  assert.equal(boom.reason, "request_failed");
  assert.equal(boom.error, "503");
  assert.equal(boom.matches[0].name, "cloudflare");

  const junk = await selectSkills({
    skills: LIBRARY,
    query: "cloudflare",
    env: ENV,
    ask: async () => ({ answers: { best: { type: "noul", noul: 0.5 } } }),
  });
  assert.equal(junk.reason, "unusable_answer");
});

test("a large library falls back to a capped lexical pool", async () => {
  const many = Array.from({ length: 200 }, (_, i) => skill(`skill-${i}`, `handles thing ${i}`));
  const { ask, calls } = fakeAsk({ "skill-0": 0.9 });
  const out = await selectSkills({ skills: many, query: "thing", env: ENV, ask });
  assert.equal(out.reason, "shortlist");
  assert.equal(Object.keys(calls[0].questions.best.criteria).length, 31); // 30 + none_of_these
});

test("gives the provider a short budget and forwards cancellation", async () => {
  const controller = new AbortController();
  const seen = [];
  const ask = async (request) => {
    seen.push(request);
    return { answers: { best: { type: "choice", choice: "cloudflare" } } };
  };
  await selectSkills({ skills: LIBRARY, query: "q", env: ENV, ask, signal: controller.signal });
  assert.equal(seen[0].signal, controller.signal);
  assert.equal(seen[0].env.TYPESAFE_TIMEOUT_MS, "3000");
  for (const junk of ["", "soon", "0", "-5"]) {
    await selectSkills({
      skills: LIBRARY,
      query: "q",
      env: { ...ENV, TYPESAFE_TIMEOUT_MS: junk },
      ask,
    });
    assert.equal(seen.at(-1).env.TYPESAFE_TIMEOUT_MS, "3000");
  }
  await selectSkills({
    skills: LIBRARY,
    query: "q",
    env: { ...ENV, TYPESAFE_TIMEOUT_MS: "7000" },
    ask,
  });
  assert.equal(seen.at(-1).env.TYPESAFE_TIMEOUT_MS, "7000");
});
