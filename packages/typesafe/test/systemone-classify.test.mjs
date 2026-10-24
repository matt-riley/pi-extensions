// Contract for moving askSystemOne onto Pi's classifier API.
//
// These tests describe the behaviour that has to survive the move: classify
// when a TypeSafe System One model is registered, the direct HTTP transport
// when it is not, the jev-1.13.0 pin, 429/529 retries, redaction and
// validation, and the fail-open / fail-closed gates. They talk to askSystemOne
// with a fake registry. Nothing here should reach the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { askSystemOne, bindSystemOne, formatAnswers } from "../../../shared/systemone.mjs";
import { judgeToolCall } from "../../guardrail/judge.mjs";
import { claimLine, judgeDoneClaim } from "../../done-gate/claim.mjs";
import { rankSkills } from "../../skill-select/library.mjs";
import { selectSkills } from "../../skill-select/select.mjs";

const ENV = { TYPESAFE_API_KEY: "ts-secret-key" };
const NO_KEY_HOME = join(tmpdir(), "pi-typesafe-classify-no-home");
const NO_KEY_ENV = { HOME: NO_KEY_HOME, LORE_CONFIG: join(NO_KEY_HOME, "lore.json") };

const A_JWT = [
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  ".eyJzdWIiOiIxMjM0NTY3OD",
  "kwIn0.SflKxwRJSMeKKF2QT4fwpMeJf",
].join("");
const A_GITHUB_TOKEN = ["ghp_", "abcdefghijklmnopqrstuvwxyz0123456789"].join("");

const NOUL = { pick: { type: "noul", instructions: "Looking at `note`: is it fine?" } };

function typesafeModel(id = "jev-latest") {
  return {
    id,
    type: "classifier",
    provider: "typesafe",
    api: "typesafe-system-one",
    baseUrl: "https://api.typesafe.ai/v1",
    contextWindow: 64000,
  };
}

function piUsage(input = 3, output = 1) {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function classifierCtx(classify, { models = [typesafeModel()] } = {}) {
  const calls = [];
  const ctx = {
    modelRegistry: {
      findOfType(kind, provider, id) {
        return models.find(
          (model) => model.type === kind && model.provider === provider && model.id === id,
        );
      },
      getModelsOfType(kind, provider) {
        return models.filter((model) => model.type === kind && model.provider === provider);
      },
      async classify(model, context, options) {
        calls.push({ model, context, options });
        return classify(model, context, options);
      },
    },
  };
  return { ctx, calls };
}

function emptyRegistry() {
  const calls = [];
  return {
    calls,
    ctx: {
      modelRegistry: {
        findOfType() {
          return undefined;
        },
        getModelsOfType() {
          return [];
        },
        async classify() {
          calls.push("classify");
          throw new Error("classify should not run without a TypeSafe model");
        },
      },
    },
  };
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const text = JSON.stringify(body);
  const response = {
    ok: status >= 200 && status < 300,
    status,
    headers,
    clone() {
      return jsonResponse(body, { status, headers });
    },
    json: async () => body,
    text: async () => text,
  };
  return response;
}

function capturingFetch(responseFactory) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined });
    return responseFactory(calls.length, { url, init });
  };
  return { fetchImpl, calls };
}

function boomFetch() {
  return async () => {
    throw new Error("direct HTTP transport was used");
  };
}

function stopResult(answers, usage = piUsage()) {
  return { stopReason: "stop", answers, usage };
}

test("classify path: a registered TypeSafe classifier receives the redacted state and raw noul answers win", async () => {
  const catalog = typesafeModel("jev-latest");
  const raw = {
    model: "jev-1.13.0",
    answers: {
      pick: { type: "noul", noul: 0.77 },
      risk: {
        type: "score",
        score: 1,
        probabilities: { 0: 0.2, 1: 0.8 },
        legend: { 0: "low", 1: "high" },
      },
    },
    usage: { input_tokens: 4, output_tokens: 2 },
  };
  const { fetchImpl, calls: httpCalls } = capturingFetch(() => jsonResponse(raw));
  const { ctx, calls } = classifierCtx(
    async (_model, _context, options) => {
      const response = await options.fetch("https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        headers: { authorization: "Bearer x", "content-type": "application/json" },
        body: "{}",
      });
      await response.json();
      // Pi's parser drops score distributions and rewrites noul to bool.
      return stopResult({
        pick: { type: "bool", probability: 0.1 },
        risk: { type: "score", score: 0 },
      });
    },
    { models: [catalog] },
  );

  const result = await askSystemOne({
    state: { note: "hello" },
    questions: {
      pick: NOUL.pick,
      risk: {
        type: "score",
        instructions: "Looking at `note`: how risky?",
        criteria: ["low", "high"],
      },
    },
    env: ENV,
    ctx,
    fetchImpl,
  });

  assert.equal(calls.length, 1, "classify was not used");
  const { model, context, options } = calls[0];
  assert.equal(model.id, "jev-1.13.0");
  assert.equal(model.provider, "typesafe");
  assert.equal(model.api, "typesafe-system-one");
  assert.equal(catalog.id, "jev-latest", "the catalog model must not be mutated");
  assert.deepEqual(Object.keys(context).sort(), ["questions", "state"]);
  assert.equal(context.questions.pick.type, "noul");
  assert.equal(context.state.note, "hello");
  assert.equal(options.headers["User-Agent"], null);
  assert.equal(options.maxRetries, 0);
  assert.equal(options.apiKey, "ts-secret-key");
  assert.equal(
    Object.keys(options.headers).some(
      (name) => name.toLowerCase() === "typesafe-danger-zone-images",
    ),
    false,
  );
  assert.equal(httpCalls.length, 1);
  assert.equal(httpCalls[0].init.redirect, "error");
  assert.equal(result.answers.pick.type, "noul");
  assert.equal(result.answers.pick.noul, 0.77);
  assert.equal(result.answers.risk.probabilities["1"], 0.8);
  assert.equal(result.answers.risk.legend["1"], "high");
  assert.deepEqual(result.usage, { input_tokens: 4, output_tokens: 2 });
  assert.equal(result.model, "jev-1.13.0");
});

test("classify path: Pi bool answers become noul when the response body cannot be read raw", async () => {
  const { ctx, calls } = classifierCtx(async () =>
    stopResult({
      pick: { type: "bool", probability: 0.42 },
      risk: { type: "score", score: 2, probabilities: { 0: 0.1, 2: 0.9 } },
    }),
  );
  const result = await askSystemOne({
    state: { note: "hello" },
    questions: NOUL,
    env: ENV,
    ctx,
    fetchImpl: boomFetch(),
  });
  assert.equal(calls.length, 1, "classify was not used");
  assert.equal(result.answers.pick.type, "noul");
  assert.equal(result.answers.pick.noul, 0.42);
  assert.equal(result.answers.risk.score, 2);
  assert.equal(result.usage.input_tokens, 3);
  assert.equal(result.usage.output_tokens, 1);
});

test("classify path: a missing answer falls back to the raw response body", async () => {
  const questions = {
    pick: { type: "noul", instructions: "Looking at `note`: is it fine?" },
    risk: { type: "noul", instructions: "Looking at `note`: is it risky?" },
  };
  const raw = {
    model: "jev-1.13.0",
    answers: { pick: { type: "noul", noul: 0.77 } },
    usage: { input_tokens: 4, output_tokens: 2 },
  };
  const { fetchImpl } = capturingFetch(() => jsonResponse(raw));
  const { ctx } = classifierCtx(async (_model, _context, options) => {
    await options.fetch("https://api.typesafe.ai/v1/systemone", { method: "POST" });
    // Pi's parseAnswers throws this, then classify reports stopReason "error".
    // The HTTP transport would have returned the partial answers object.
    return {
      stopReason: "error",
      errorMessage: "System One API did not return an answer for risk",
      usage: piUsage(4, 2),
    };
  });
  const result = await askSystemOne({
    state: { note: "hello" },
    questions,
    env: ENV,
    ctx,
    fetchImpl,
  });
  assert.equal(result.answers.pick.type, "noul");
  assert.equal(result.answers.pick.noul, 0.77);
  assert.equal(result.answers.risk, undefined);
  assert.deepEqual(result.usage, { input_tokens: 4, output_tokens: 2 });

  const other = classifierCtx(async () => ({
    stopReason: "error",
    errorMessage: "System One API error (500): no",
  }));
  await assert.rejects(
    () =>
      askSystemOne({
        state: { note: "hello" },
        questions,
        env: ENV,
        ctx: other.ctx,
        fetchImpl: boomFetch(),
      }),
    /System One API error \(500\)/,
  );
});

test("classify path: an error from classify is not sent again over direct HTTP", async () => {
  const http = [];
  const { ctx, calls } = classifierCtx(async () => {
    throw new Error("classify exploded");
  });
  await assert.rejects(
    askSystemOne({
      state: { note: "hello" },
      questions: NOUL,
      env: ENV,
      ctx,
      fetchImpl: async () => {
        http.push("http");
        throw new Error("direct HTTP transport was used");
      },
    }),
    /classify exploded/,
  );
  assert.equal(calls.length, 1);
  assert.equal(http.length, 0);
});

test("pin: classify is asked for jev-1.13.0 when the catalog only has jev-latest", async () => {
  const { ctx, calls } = classifierCtx(async () => stopResult({ pick: { type: "noul", noul: 1 } }));
  await askSystemOne({
    state: { note: "hello" },
    questions: NOUL,
    env: ENV,
    ctx,
    fetchImpl: boomFetch(),
  });
  assert.equal(calls.length, 1, "classify was not used");
  assert.equal(calls[0].model.id, "jev-1.13.0");
  assert.equal(calls[0].model.provider, "typesafe");
  assert.equal(calls[0].model.api, "typesafe-system-one");
});

test("pin: TYPESAFE_MODEL and a per-call model override the id sent to classify", async () => {
  const fromEnv = classifierCtx(async () => stopResult({ pick: { type: "noul", noul: 1 } }));
  await askSystemOne({
    state: { note: "hello" },
    questions: NOUL,
    env: { ...ENV, TYPESAFE_MODEL: "jev-9.9.9" },
    ctx: fromEnv.ctx,
    fetchImpl: boomFetch(),
  });
  assert.equal(fromEnv.calls.length, 1, "classify was not used");
  assert.equal(fromEnv.calls[0].model.id, "jev-9.9.9");

  const perCall = classifierCtx(async () => stopResult({ pick: { type: "noul", noul: 1 } }));
  await askSystemOne({
    state: { note: "hello" },
    questions: NOUL,
    model: "jev-1.14.0",
    env: ENV,
    ctx: perCall.ctx,
    fetchImpl: boomFetch(),
  });
  assert.equal(perCall.calls[0].model.id, "jev-1.14.0");
});

test("pin: an explicit TYPESAFE_BASE_URL overrides the classifier baseUrl", async () => {
  const { ctx, calls } = classifierCtx(async () => stopResult({ pick: { type: "noul", noul: 1 } }));
  await askSystemOne({
    state: { note: "hello" },
    questions: NOUL,
    env: { ...ENV, TYPESAFE_BASE_URL: "https://proxy.test/v1/" },
    ctx,
    fetchImpl: boomFetch(),
  });
  assert.equal(calls.length, 1, "classify was not used");
  assert.equal(calls[0].model.baseUrl, "https://proxy.test/v1");
});

test("pin: an unset TYPESAFE_BASE_URL keeps the catalog baseUrl", async () => {
  const { ctx, calls } = classifierCtx(async () => stopResult({ pick: { type: "noul", noul: 1 } }));
  await askSystemOne({
    state: { note: "hello" },
    questions: NOUL,
    env: ENV,
    ctx,
    fetchImpl: boomFetch(),
  });
  assert.equal(calls.length, 1, "classify was not used");
  assert.equal(calls[0].model.baseUrl, "https://api.typesafe.ai/v1");
});

test("retries: a 429 result from classify is not asked again", async () => {
  const { ctx, calls } = classifierCtx(async () => ({
    stopReason: "error",
    errorMessage: "System One API error (429): busy",
  }));
  await assert.rejects(
    () =>
      askSystemOne({
        state: { note: "hello" },
        questions: NOUL,
        env: ENV,
        ctx,
        fetchImpl: boomFetch(),
      }),
    (error) => {
      assert.equal(calls.length, 1, "classify was not used");
      assert.equal(calls[0].options.maxRetries, 0);
      assert.match(error.message, /429/);
      assert.doesNotMatch(error.message, /direct HTTP/);
      return true;
    },
  );
});

test("retries: the fetch wrapper retries 429 then 529 and classify sets maxRetries to 0", async () => {
  const { fetchImpl, calls: httpCalls } = capturingFetch((n) =>
    n === 1
      ? jsonResponse({ error: "rate limited" }, { status: 429, headers: { "retry-after": "20" } })
      : n === 2
        ? jsonResponse({ error: "overloaded" }, { status: 529 })
        : jsonResponse({
            answers: { pick: { type: "noul", noul: 0.5 } },
            usage: { input_tokens: 2, output_tokens: 1 },
          }),
  );
  const { ctx, calls } = classifierCtx(async (_model, _context, options) => {
    const response = await options.fetch("https://api.typesafe.ai/v1/systemone", {
      method: "POST",
    });
    if (!response.ok) {
      return {
        stopReason: "error",
        errorMessage: `System One API error (${response.status}): busy`,
      };
    }
    const body = await response.json();
    return stopResult(body.answers);
  });
  const started = Date.now();
  let result;
  try {
    result = await askSystemOne({
      state: { note: "hello" },
      questions: NOUL,
      env: ENV,
      ctx,
      fetchImpl,
      retryDelayMs: 1,
    });
  } catch (error) {
    assert.equal(httpCalls.length, 3, "429 and 529 were not retried in the fetch wrapper");
    throw error;
  }
  assert.equal(httpCalls.length, 3, "429 and 529 were not retried in the fetch wrapper");
  assert.equal(calls.length, 1, "classify itself was retried");
  assert.equal(calls[0].options.maxRetries, 0);
  assert.equal(result.answers.pick.noul, 0.5);
  assert.ok(Date.now() - started < 1000, "retry-after was honored");
});

test("retries: a 529 from classify is not asked again", async () => {
  const { ctx, calls } = classifierCtx(async () => ({
    stopReason: "error",
    errorMessage: "System One API error (529): overloaded",
  }));
  await assert.rejects(
    () =>
      askSystemOne({
        state: { note: "hello" },
        questions: NOUL,
        env: ENV,
        ctx,
        fetchImpl: boomFetch(),
      }),
    (error) => {
      assert.equal(calls.length, 1, "classify was not used");
      assert.match(error.message, /529/);
      return true;
    },
  );
});

test("direct HTTP fallback: no TypeSafe classifier keeps the POST to /systemone", async () => {
  const { ctx, calls } = emptyRegistry();
  const { fetchImpl, calls: httpCalls } = capturingFetch(() =>
    jsonResponse({
      model: "jev-1.13.0",
      answers: { pick: { type: "noul", noul: 0.5 } },
      usage: { input_tokens: 2, output_tokens: 1 },
    }),
  );
  const result = await askSystemOne({
    state: { note: "hello" },
    questions: NOUL,
    env: ENV,
    ctx,
    fetchImpl,
  });
  assert.equal(calls.length, 0, "classify ran without a TypeSafe model");
  assert.equal(httpCalls.length, 1);
  assert.equal(httpCalls[0].url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(httpCalls[0].body.model, "jev-1.13.0");
  assert.equal(httpCalls[0].init.redirect, "error");
  assert.equal(httpCalls[0].init.headers.authorization, "Bearer ts-secret-key");
  assert.equal(result.answers.pick.noul, 0.5);
});

test("direct HTTP fallback: 429 then 529 still retries on the HTTP transport", async () => {
  const { ctx, calls } = emptyRegistry();
  const { fetchImpl, calls: httpCalls } = capturingFetch((n) =>
    n === 1
      ? jsonResponse({ error: "rate limited" }, { status: 429 })
      : n === 2
        ? jsonResponse({ error: "overloaded" }, { status: 529 })
        : jsonResponse({ answers: { pick: { type: "noul", noul: 0.5 } } }),
  );
  const result = await askSystemOne({
    state: { note: "hello" },
    questions: NOUL,
    env: ENV,
    ctx,
    fetchImpl,
    retryDelayMs: 1,
  });
  assert.equal(calls.length, 0);
  assert.equal(httpCalls.length, 3);
  assert.equal(result.answers.pick.noul, 0.5);
});

test("direct HTTP fallback: a missing modelRegistry keeps the direct POST", async () => {
  const { fetchImpl, calls } = capturingFetch(() =>
    jsonResponse({ answers: { pick: { type: "noul", noul: 1 } } }),
  );
  const result = await askSystemOne({
    state: { note: "hello" },
    questions: NOUL,
    env: ENV,
    fetchImpl,
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(result.answers.pick.noul, 1);
});

test("redaction: secrets are removed before classify sees the state", async () => {
  const { ctx, calls } = classifierCtx(async () => stopResult({ pick: { type: "noul", noul: 1 } }));
  const result = await askSystemOne({
    state: {
      note: `curl -H "Authorization: Bearer ${A_JWT}"`,
      env_file: `GITHUB_TOKEN=${A_GITHUB_TOKEN}`,
      client: "the client key is ts-secret-key",
    },
    questions: NOUL,
    env: ENV,
    ctx,
    fetchImpl: boomFetch(),
  });
  assert.equal(calls.length, 1, "classify was not used");
  const sent = JSON.stringify(calls[0].context.state);
  assert.equal(sent.includes(A_JWT), false);
  assert.equal(sent.includes(A_GITHUB_TOKEN), false);
  assert.equal(sent.includes("ts-secret-key"), false);
  assert.match(sent, /<REDACTED:/);
  assert.ok(result.redactions >= 3);
});

test("redaction: personal identifiers are masked before classify sees the state", async () => {
  const home = homedir();
  const state = { file: join(home, "project", "app.ts"), identity: "alice@example.invalid" };
  const questions = { q: { type: "noul", instructions: "Does this name a source file?" } };
  const { ctx, calls } = classifierCtx(async () => stopResult({ q: { type: "noul", noul: 0.5 } }));
  const result = await askSystemOne({
    state,
    questions,
    env: ENV,
    ctx,
    fetchImpl: boomFetch(),
  });
  assert.equal(calls.length, 1, "classify was not used");
  assert.equal(calls[0].context.state.file, "<REDACTED:home>" + state.file.slice(home.length));
  assert.equal(calls[0].context.state.identity, state.identity);
  assert.equal(result.redactions, 0, "a home path is not evidence of a credential leak");
  assert.equal(result.privacyRedactions, 1);
  assert.match(formatAnswers(result), /1 redacted/);
  assert.equal(state.file, join(home, "project", "app.ts"));

  const masked = classifierCtx(async () => stopResult({ q: { type: "noul", noul: 0.5 } }));
  const emailState = { identity: "alice+work@example.invalid" };
  const emailResult = await askSystemOne({
    state: emailState,
    questions,
    env: { ...ENV, PI_MASK_EMAILS: "1" },
    ctx: masked.ctx,
    fetchImpl: boomFetch(),
  });
  assert.equal(masked.calls.length, 1, "classify was not used");
  assert.equal(masked.calls[0].context.state.identity, "<REDACTED:email>");
  assert.equal(emailResult.redactions, 0, "an email address is not a credential");
  assert.equal(emailResult.privacyRedactions, 1);
  assert.equal(emailState.identity, "alice+work@example.invalid");
});

test("validation: a one-option choice is refused before classify or HTTP", async () => {
  const { ctx, calls } = classifierCtx(async () => stopResult({}));
  const http = [];
  await assert.rejects(
    () =>
      askSystemOne({
        state: { note: "hello" },
        questions: { c: { type: "choice", instructions: "?", criteria: { only: null } } },
        env: ENV,
        ctx,
        fetchImpl: async () => {
          http.push("http");
          throw new Error("direct HTTP transport was used");
        },
      }),
    /at least two options/i,
  );
  assert.equal(calls.length, 0);
  assert.equal(http.length, 0);
});

test("auth: a local key is required before classify, even when Pi has a stored TypeSafe login", async () => {
  const { ctx, calls } = classifierCtx(async () =>
    stopResult({ pick: { type: "bool", probability: 0.5 } }),
  );
  ctx.modelRegistry.getApiKeyForProvider = async () => "ts-stored-pi-key";
  let caught;
  try {
    await askSystemOne({
      state: { note: "hello" },
      questions: NOUL,
      env: NO_KEY_ENV,
      ctx,
      fetchImpl: boomFetch(),
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(calls.length, 0, "classify ran without a local key");
  assert.match(caught?.message ?? "", /TYPESAFE_API_KEY is not set/);
});

test("auth: with no local key, classify is not called", async () => {
  const { ctx, calls } = classifierCtx(async () =>
    stopResult({ pick: { type: "bool", probability: 0.5 } }),
  );
  await assert.rejects(
    () =>
      askSystemOne({
        state: { note: "hello" },
        questions: NOUL,
        env: NO_KEY_ENV,
        ctx,
        fetchImpl: boomFetch(),
      }),
    /TYPESAFE_API_KEY is not set/,
  );
  assert.equal(calls.length, 0, "classify ran without a local key");
});

test("auth: no local key is refused with the TYPESAFE_API_KEY message before classify", async () => {
  const { ctx, calls } = classifierCtx(async () => ({
    stopReason: "error",
    errorMessage: "No API key for provider: typesafe",
  }));
  await assert.rejects(
    () =>
      askSystemOne({
        state: { note: "hello" },
        questions: NOUL,
        env: NO_KEY_ENV,
        ctx,
        fetchImpl: boomFetch(),
      }),
    (error) => {
      assert.equal(calls.length, 0, "classify ran without a local key");
      assert.match(error.message, /TYPESAFE_API_KEY is not set/);
      return true;
    },
  );
});

test("auth: a local key is forwarded and a Pi auth error is left as Pi reported it", async () => {
  const { ctx, calls } = classifierCtx(async () => ({
    stopReason: "error",
    errorMessage: "No API key for provider: typesafe",
  }));
  await assert.rejects(
    () =>
      askSystemOne({
        state: { note: "hello" },
        questions: NOUL,
        env: ENV,
        ctx,
        fetchImpl: boomFetch(),
      }),
    (error) => {
      assert.equal(calls.length, 1, "classify was not used");
      assert.equal(calls[0].options.apiKey, "ts-secret-key");
      assert.match(error.message, /No API key for provider: typesafe/);
      assert.doesNotMatch(error.message, /TYPESAFE_API_KEY is not set/);
      return true;
    },
  );
});

function gateAsk(ctx) {
  return (request) => askSystemOne({ ...request, ctx, fetchImpl: boomFetch() });
}

test("fail-open: a low-risk classify answer still allows the guarded call", async () => {
  const { ctx, calls } = classifierCtx(async (_model, context) => {
    const answers = {};
    for (const [id, question] of Object.entries(context.questions)) {
      answers[id] =
        question.type === "score"
          ? { type: "score", score: 0 }
          : { type: "bool", probability: 0.05 };
    }
    return stopResult(answers);
  });
  const judged = await judgeToolCall({
    action: "rm src/app.ts",
    toolName: "bash",
    cwd: "/tmp/proj",
    userRequest: "delete the unused module",
    env: ENV,
    ask: gateAsk(ctx),
  });
  assert.equal(calls.length, 1, "classify was not used");
  assert.equal(judged.judged, true);
  assert.equal(judged.verdict, "allow");
});

test("fail-open: guardrail confirms when classify errors and a person can be asked", async () => {
  const { ctx, calls } = classifierCtx(async () => ({
    stopReason: "error",
    errorMessage: "System One API error (529): overloaded",
  }));
  const judged = await judgeToolCall({
    action: "rm src/app.ts",
    toolName: "bash",
    cwd: "/tmp/proj",
    fallbackVerdict: "confirm",
    env: ENV,
    ask: gateAsk(ctx),
  });
  assert.equal(calls.length, 1, "classify was not used");
  assert.equal(judged.judged, false);
  assert.equal(judged.verdict, "confirm");
  assert.match(judged.reason, /529/);
});

test("fail-closed: guardrail blocks when classify errors and there is no one to ask", async () => {
  const { ctx, calls } = classifierCtx(async () => ({
    stopReason: "error",
    errorMessage: "System One API error (429): busy",
  }));
  const judged = await judgeToolCall({
    action: "rm src/app.ts",
    toolName: "bash",
    cwd: "/tmp/proj",
    fallbackVerdict: "block",
    env: ENV,
    ask: gateAsk(ctx),
  });
  assert.equal(calls.length, 1, "classify was not used");
  assert.equal(judged.judged, false);
  assert.equal(judged.verdict, "block");
  assert.match(judged.reason, /429/);
});

test("fail-open: done-gate still flags an unclosed claim mapped from bool answers", async () => {
  const { ctx, calls } = classifierCtx(async () =>
    stopResult({
      asserts_verified: { type: "bool", probability: 0.9 },
      acknowledges_gap: { type: "bool", probability: 0.02 },
      claims_remote: { type: "bool", probability: 0.1 },
    }),
  );
  const judged = await judgeDoneClaim({
    claim: "All checks passed and the feature is done.",
    files: ["src/app.ts"],
    verificationSeen: false,
    remoteVerificationSeen: false,
    env: ENV,
    ask: gateAsk(ctx),
  });
  assert.equal(calls.length, 1, "classify was not used");
  assert.equal(judged.judged, true);
  assert.equal(judged.verdict, "unclosed");
  assert.match(claimLine(judged), /unverified/);
});

test("fail-open: done-gate stays silent when classify errors", async () => {
  const { ctx, calls } = classifierCtx(async () => ({
    stopReason: "error",
    errorMessage: "System One API error (529): overloaded",
  }));
  const judged = await judgeDoneClaim({
    claim: "All checks passed and the feature is done.",
    files: ["src/app.ts"],
    verificationSeen: false,
    env: ENV,
    ask: gateAsk(ctx),
  });
  assert.equal(calls.length, 1, "classify was not used");
  assert.equal(judged.judged, false);
  assert.equal(judged.verdict, null);
  assert.equal(claimLine(judged), null);
  assert.match(judged.reason, /529/);
});

const SKILLS = [
  {
    name: "cloudflare",
    description: "Workers, KV, D1 and R2 on Cloudflare",
    path: "/lib/cloudflare/SKILL.md",
  },
  {
    name: "web-perf",
    description: "Measure and improve page load performance",
    path: "/lib/web-perf/SKILL.md",
  },
  {
    name: "grill-me",
    description: "Stress-test a plan or design decision",
    path: "/lib/grill-me/SKILL.md",
  },
];

test("classify path: skill-select orders by the choice classify returns", async () => {
  const { ctx, calls } = classifierCtx(async () =>
    stopResult({
      best: {
        type: "choice",
        choice: "web-perf",
        probabilities: { "web-perf": 0.7, cloudflare: 0.2, "grill-me": 0.05, none_of_these: 0.05 },
      },
    }),
  );
  const out = await selectSkills({
    skills: SKILLS,
    query: "make it faster",
    limit: 2,
    env: { PI_SKILL_SELECT_TIEBREAK: "1", ...ENV },
    ask: gateAsk(ctx),
  });
  assert.equal(calls.length, 1, "classify was not used");
  assert.deepEqual(
    out.matches.map((entry) => entry.name),
    ["web-perf", "cloudflare"],
  );
  assert.equal(out.reason, "wide");
});

test("fail-open: skill-select keeps lexical order when classify errors", async () => {
  const { ctx, calls } = classifierCtx(async () => ({
    stopReason: "error",
    errorMessage: "System One API error (429): busy",
  }));
  const query = "make it faster";
  const out = await selectSkills({
    skills: SKILLS,
    query,
    limit: 2,
    env: { PI_SKILL_SELECT_TIEBREAK: "1", ...ENV },
    ask: gateAsk(ctx),
  });
  const lexical = rankSkills(SKILLS, query, { limit: 2 });
  assert.equal(calls.length, 1, "classify was not used");
  assert.equal(out.reason, "request_failed");
  assert.deepEqual(
    out.matches.map((entry) => entry.name),
    lexical.map((entry) => entry.name),
  );
});

test("redaction: Pi's stored TypeSafe key is removed before classify sees the state", async () => {
  const stored = "ts-stored-pi-key";
  const { ctx, calls } = classifierCtx(async () => stopResult({ pick: { type: "noul", noul: 1 } }));
  ctx.modelRegistry.getApiKeyForProvider = async (provider) =>
    provider === "typesafe" ? stored : undefined;
  const result = await askSystemOne({
    state: { note: `authorization ${stored}` },
    questions: NOUL,
    env: ENV,
    ctx,
    fetchImpl: boomFetch(),
  });
  assert.equal(calls.length, 1, "classify was not used");
  const sent = JSON.stringify(calls[0].context.state);
  assert.equal(sent.includes(stored), false, "Pi's stored key was sent in the state");
  assert.match(sent, /<REDACTED:/);
  assert.ok(result.redactions >= 1);
});

test("usage: tool_result and tool execute add Jev's tokens to usage that is already set", async () => {
  const handlers = {};
  const tools = {};
  const pi = {
    on(event, handler) {
      (handlers[event] ??= []).push(handler);
    },
    registerTool(def) {
      tools[def.name] = def;
    },
  };
  bindSystemOne(pi);
  const jev = piUsage(11, 0);
  const tool = {
    input: 100,
    output: 20,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 120,
    cost: { input: 0.18, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.18 },
  };
  const { ctx } = classifierCtx(async () => stopResult({ pick: { type: "noul", noul: 1 } }, jev));
  const ask = () =>
    askSystemOne({
      state: { note: "hello" },
      questions: NOUL,
      env: ENV,
      fetchImpl: boomFetch(),
    });

  pi.on("tool_result", async () => {
    await ask();
    return { content: [{ type: "text", text: "nudge" }] };
  });
  const replaced = await handlers.tool_result[0]({ usage: tool, content: [] }, ctx);
  assert.equal(replaced.usage.input, 111, "Jev's usage replaced the tool's");
  assert.equal(replaced.usage.cost.total, 0.18);

  pi.on("tool_result", async () => {
    await ask();
  });
  const silent = await handlers.tool_result[1]({ usage: tool, content: [] }, ctx);
  assert.deepEqual(silent, { usage: { ...tool, input: 111, output: 20, totalTokens: 131 } });

  pi.registerTool({
    name: "ask",
    async execute() {
      await ask();
      return { content: [{ type: "text", text: "ok" }], usage: tool };
    },
  });
  const executed = await tools.ask.execute("id", {}, undefined, undefined, ctx);
  assert.equal(executed.usage.input, 111, "existing tool usage was left unchanged");
  assert.equal(executed.usage.cost.total, 0.18);
});
