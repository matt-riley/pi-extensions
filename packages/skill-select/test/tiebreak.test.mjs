import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TIEBREAK_ENV,
  needsTiebreak,
  tiebreakEnabled,
  tiebreakMatches,
} from "../tiebreak.mjs";

const ENV = { [TIEBREAK_ENV]: "1", TYPESAFE_API_KEY: "tb-key" };
// Guaranteed-absent config path: the key-less cases must not read a real
// machine's lore config, or the suite passes and fails by environment.
const NO_KEY_ENV = { LORE_CONFIG: join(tmpdir(), "pi-tiebreak-absent", "lore.json") };

function match(name, score) {
  return { name, score, description: `${name} description`, path: `/lib/${name}/SKILL.md` };
}

function fakeAsk(choice, calls = []) {
  const ask = async (request) => {
    calls.push(request);
    return { model: "jev-latest", answers: { best: { type: "choice", choice, confidence: 0.8 } } };
  };
  return { ask, calls };
}

test("tiebreakEnabled is on by default with a key and off on request", () => {
  assert.equal(tiebreakEnabled({ [TIEBREAK_ENV]: "1", TYPESAFE_API_KEY: "k" }), true);
  assert.equal(tiebreakEnabled({ TYPESAFE_API_KEY: "k" }), true);
  assert.equal(tiebreakEnabled({ LORE_TYPESAFE_API_KEY: "k" }), true);
  assert.equal(tiebreakEnabled(NO_KEY_ENV), false);
  assert.equal(tiebreakEnabled({ [TIEBREAK_ENV]: "1", ...NO_KEY_ENV }), false);
  assert.equal(tiebreakEnabled({ [TIEBREAK_ENV]: "0", TYPESAFE_API_KEY: "k" }), false);
  assert.equal(tiebreakEnabled({ [TIEBREAK_ENV]: "off", TYPESAFE_API_KEY: "k" }), false);
  assert.equal(tiebreakEnabled({ [TIEBREAK_ENV]: "false", TYPESAFE_API_KEY: "k" }), false);
});

test("needsTiebreak only fires when the top scores are close", () => {
  assert.equal(needsTiebreak([match("a", 9), match("b", 3)]), false);
  assert.equal(needsTiebreak([match("a", 9), match("b", 8.5)]), true);
  assert.equal(needsTiebreak([match("a", 9)]), false);
  assert.equal(needsTiebreak([]), false);
});

test("asks one choice question over the close candidates and promotes the winner", async () => {
  const matches = [match("cloudflare", 9), match("sandbox-next", 8.6), match("wrangler", 4)];
  const { ask, calls } = fakeAsk("sandbox-next");
  const result = await tiebreakMatches({ query: "run untrusted code", matches, env: ENV, ask });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].questions.best.type, "choice");
  assert.deepEqual(Object.keys(calls[0].questions.best.criteria), ["cloudflare", "sandbox-next", "wrangler", "none_of_these"]);
  assert.equal(calls[0].state.task, "run untrusted code");
  assert.equal(result.applied, true);
  assert.equal(result.reason, "reordered");
  assert.equal(result.chosen, "sandbox-next");
  assert.deepEqual(result.matches.map((entry) => entry.name), ["sandbox-next", "cloudflare", "wrangler"]);
});

test("leaves the order alone when the model declines", async () => {
  const matches = [match("cloudflare", 9), match("sandbox-next", 8.6)];
  const { ask, calls } = fakeAsk("none_of_these");
  const result = await tiebreakMatches({ query: "anything", matches, env: ENV, ask });
  assert.equal(calls.length, 1);
  assert.equal(result.applied, false);
  assert.equal(result.reason, "declined");
  assert.deepEqual(result.matches.map((entry) => entry.name), ["cloudflare", "sandbox-next"]);
});

test("does not call the provider when disabled or when scores are separated", async () => {
  const { ask, calls } = fakeAsk("sandbox-next");
  const disabled = await tiebreakMatches({ query: "q", matches: [match("a", 9), match("b", 8.9)], env: NO_KEY_ENV, ask });
  assert.equal(disabled.reason, "disabled");
  const optedOut = await tiebreakMatches({
    query: "q",
    matches: [match("a", 9), match("b", 8.9)],
    env: { ...ENV, [TIEBREAK_ENV]: "0" },
    ask,
  });
  assert.equal(optedOut.reason, "disabled");
  const separated = await tiebreakMatches({ query: "q", matches: [match("a", 9), match("b", 2)], env: ENV, ask });
  assert.equal(separated.reason, "scores_separated");
  assert.equal(calls.length, 0);
});

test("fails open when the provider errors", async () => {
  const matches = [match("cloudflare", 9), match("sandbox-next", 8.6)];
  const ask = async () => { throw new Error("socket hang up"); };
  const result = await tiebreakMatches({ query: "q", matches, env: ENV, ask });
  assert.equal(result.applied, false);
  assert.equal(result.reason, "request_failed");
  assert.match(result.error, /socket hang up/);
  assert.deepEqual(result.matches.map((entry) => entry.name), ["cloudflare", "sandbox-next"]);
});

test("caps the candidate list sent to the provider", async () => {
  const matches = Array.from({ length: 12 }, (_, index) => match(`skill-${index}`, 9 - index * 0.1));
  const { ask, calls } = fakeAsk("skill-3");
  await tiebreakMatches({ query: "q", matches, env: ENV, ask });
  assert.equal(Object.keys(calls[0].questions.best.criteria).length, 8 + 1);
});
