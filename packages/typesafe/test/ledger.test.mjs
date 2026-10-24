// Decision ledger: every Jev call leaves a local session entry.
//
// Pi 1.4 appendEntry(customType, data?) persists a custom entry that does not
// enter the model context. These tests describe that entry before the hook exists.

import { test } from "node:test";
import assert from "node:assert/strict";

import { askSystemOne, bindSystemOne } from "../../../shared/systemone.mjs";

const ENV = { TYPESAFE_API_KEY: "ts-secret-key" };

function jsonResponse(body, { status = 200 } = {}) {
  const text = JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    clone() {
      return jsonResponse(body, { status });
    },
    json: async () => body,
    text: async () => text,
  };
}

function capturingFetch(responseFactory) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined });
    return responseFactory(calls.length);
  };
  return { fetchImpl, calls };
}

/** A pi that records appendEntry and runs the handler bindSystemOne wraps. */
function sessionPi() {
  const entries = [];
  const handlers = [];
  const pi = {
    entries,
    handlers,
    appendEntry(customType, data) {
      entries.push({ customType, data });
    },
    on(event, handler) {
      handlers.push({ event, handler });
    },
  };
  bindSystemOne(pi);
  return pi;
}

const QUESTIONS = {
  destructive: {
    type: "noul",
    instructions: "Looking at `note`: could it destroy something irreplaceable?",
    criteria: { true: "yes", false: "no" },
  },
  blast_radius: {
    type: "score",
    instructions: "If `note` went wrong, how far would it reach?",
    criteria: ["Nothing", "This machine"],
  },
};

test("askSystemOne appends a jev-decision entry for a successful call", async () => {
  const { fetchImpl } = capturingFetch(() =>
    jsonResponse({
      model: "jev-1.13.0",
      answers: {
        destructive: { type: "noul", noul: 0.2 },
        blast_radius: {
          type: "score",
          score: 1.5,
          probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 },
          confidence: 0.8,
        },
      },
      usage: { input_tokens: 10, output_tokens: 4 },
    }),
  );
  const pi = sessionPi();
  pi.on("tool_call", () =>
    askSystemOne({
      state: { note: "plain" },
      questions: QUESTIONS,
      feature: "guardrail",
      model: "jev-1.13.0",
      env: ENV,
      fetchImpl,
    }),
  );

  const result = await pi.handlers[0].handler({}, {});

  assert.equal(pi.entries.length, 1);
  const entry = pi.entries[0];
  assert.equal(entry.customType, "jev-decision");
  assert.equal(entry.data.feature, "guardrail");
  assert.equal(entry.data.model, "jev-1.13.0");
  assert.equal(entry.data.requestedModel, "jev-1.13.0");
  assert.deepEqual(
    entry.data.questions.map(({ id, kind }) => ({ id, kind })),
    [
      { id: "destructive", kind: "noul" },
      { id: "blast_radius", kind: "score" },
    ],
  );
  assert.equal(entry.data.answers.destructive.noul, 0.2);
  assert.equal(entry.data.answers.blast_radius.score, 1.5);
  assert.equal(entry.data.answers.blast_radius.probabilities["2"], 0.7);
  assert.equal(typeof entry.data.latencyMs, "number");
  assert.ok(entry.data.latencyMs >= 0);
  assert.equal(entry.data.transport, "http");
  assert.equal(entry.data.redactions, 0);
  assert.equal(entry.data.privacyRedactions, 0);
  assert.equal(entry.data.outcome, "ok");
  assert.equal(result.model, "jev-1.13.0");
  assert.equal(result.answers.destructive.noul, 0.2);
});

test("a bound pi without appendEntry still returns the Jev answer", async () => {
  const { fetchImpl } = capturingFetch(() =>
    jsonResponse({
      model: "jev-1.13.0",
      answers: { destructive: { type: "noul", noul: 0.2 } },
      usage: {},
    }),
  );
  const handlers = [];
  const pi = {
    on(event, handler) {
      handlers.push({ event, handler });
    },
  };
  bindSystemOne(pi);
  pi.on("tool_call", () =>
    askSystemOne({
      state: { note: "plain" },
      questions: {
        destructive: { type: "noul", instructions: "Looking at `note`: is it fine?" },
      },
      env: ENV,
      fetchImpl,
    }),
  );

  const result = await handlers[0].handler({}, {});
  assert.equal(result.answers.destructive.noul, 0.2);
});

test("a throwing appendEntry still returns the Jev answer", async () => {
  const { fetchImpl } = capturingFetch(() =>
    jsonResponse({
      model: "jev-1.13.0",
      answers: { destructive: { type: "noul", noul: 0.2 } },
      usage: {},
    }),
  );
  const pi = sessionPi();
  pi.appendEntry = () => {
    throw new Error("session disk full");
  };
  pi.on("tool_call", () =>
    askSystemOne({
      state: { note: "plain" },
      questions: {
        destructive: { type: "noul", instructions: "Looking at `note`: is it fine?" },
      },
      env: ENV,
      fetchImpl,
    }),
  );

  const result = await pi.handlers[0].handler({}, {});
  assert.equal(result.answers.destructive.noul, 0.2);
});

test("askSystemOne records classify as the transport when Pi answers", async () => {
  const pi = sessionPi();
  const ctx = {
    modelRegistry: {
      findOfType() {
        return {
          id: "jev-1.13.0",
          type: "classifier",
          provider: "typesafe",
          api: "typesafe-system-one",
          baseUrl: "https://api.typesafe.ai/v1",
        };
      },
      async classify() {
        return {
          stopReason: "stop",
          model: "jev-1.14.0",
          answers: { pick: { type: "noul", noul: 0.4 } },
          usage: {
            input: 2,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 3,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
      },
    },
  };
  pi.on("tool_call", () =>
    askSystemOne({
      state: { note: "plain" },
      questions: { pick: { type: "noul", instructions: "Looking at `note`: is it fine?" } },
      env: ENV,
      ctx,
      fetchImpl: async () => {
        throw new Error("http fallback should not run");
      },
    }),
  );

  const result = await pi.handlers[0].handler({}, {});
  assert.equal(pi.entries.length, 1);
  assert.equal(pi.entries[0].data.transport, "classify");
  assert.equal(pi.entries[0].data.model, "jev-1.14.0");
  assert.equal(pi.entries[0].data.requestedModel, "jev-1.13.0");
  assert.equal(result.answers.pick.noul, 0.4);
  assert.equal(result.model, "jev-1.14.0");
});

test("a ledger entry never contains state contents, question text, or the api key", async () => {
  const stateSentinel = "STATE-SENTINEL-9f3a-not-a-secret";
  const questionSentinel = "QUESTION-SENTINEL-user-typed-this";
  const apiKey = "ts-secret-key";
  const { fetchImpl } = capturingFetch(() =>
    jsonResponse({
      model: "jev-1.13.0",
      answers: {
        destructive: { type: "noul", noul: 0.1 },
        echoed: { type: "choice", choice: apiKey, confidence: 0.4 },
      },
      usage: {},
    }),
  );
  const pi = sessionPi();
  pi.on("tool_call", () =>
    askSystemOne({
      state: { note: stateSentinel, authorization: apiKey },
      questions: {
        destructive: {
          type: "noul",
          instructions: `Looking at \`note\`: ${questionSentinel}`,
          criteria: { true: questionSentinel, false: "no" },
        },
      },
      env: { TYPESAFE_API_KEY: apiKey },
      fetchImpl,
    }),
  );

  await pi.handlers[0].handler({}, {});
  const entry = pi.entries[0];
  const text = JSON.stringify(entry);
  assert.equal(text.includes(questionSentinel), false, "question text reached the entry");
  assert.equal(text.includes(stateSentinel), false, "state contents reached the entry");
  assert.equal(text.includes(apiKey), false, "api key reached the entry");
  assert.equal(entry.data.state, undefined);
  assert.ok(entry.data.redactions >= 1);
  assert.equal(entry.data.answers.destructive.noul, 0.1);
});
