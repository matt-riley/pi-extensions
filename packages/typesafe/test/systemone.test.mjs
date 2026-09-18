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
} from "../systemone.mjs";

const ENV = { TYPESAFE_API_KEY: "ts-secret-key" };
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
  assert.throws(() => resolveConfig({ TYPESAFE_BASE_URL: "ftp://example.test", ...NO_KEY_ENV }), /http/i);
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
    assert.equal(resolveConfig({ ...NO_KEY_ENV, HOME: dir, LORE_CONFIG: join(dir, "missing.json") }).apiKey, "");

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
    writeFileSync(join(home, ".copilot", "lore.json"), JSON.stringify({ typesafe: { apiKey: "legacy" } }));
    writeFileSync(join(xdg, "lore", "lore.json"), JSON.stringify({ typesafe: { apiKey: "xdg" } }));

    assert.equal(resolveConfig({ HOME: home, XDG_CONFIG_HOME: xdg }).apiKey, "xdg");

    const loreHome = join(dir, "lorehome");
    mkdirSync(loreHome, { recursive: true });
    writeFileSync(join(loreHome, "lore.json"), JSON.stringify({ typesafe: { apiKey: "from-lore-home" } }));
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

test("validateQuestions accepts the three primitives and rejects malformed ones", () => {
  assert.doesNotThrow(() => validateQuestions({
    urgent: { type: "noul", instructions: "Does this convey urgency?" },
    team: { type: "choice", instructions: "Which team?", criteria: { billing: "Payments", tech: null } },
    risk: { type: "score", instructions: "How risky?", criteria: ["Low", "Medium", "High"] },
  }));
  assert.throws(() => validateQuestions({}), /at least one question/i);
  assert.throws(() => validateQuestions(null), /at least one question/i);
  assert.throws(() => validateQuestions({ a: { type: "vote", instructions: "?" } }), /unknown question type/i);
  assert.throws(() => validateQuestions({ a: { type: "noul" } }), /instructions/i);
  assert.throws(() => validateQuestions({ a: { type: "choice", instructions: "?", criteria: { only: "one" } } }), /at least two options/i);
  assert.throws(() => validateQuestions({ a: { type: "score", instructions: "?", criteria: ["only"] } }), /at least two ordered levels/i);
  assert.throws(() => validateQuestions({ a: { type: "score", instructions: "?", criteria: "not-an-array" } }), /at least two ordered levels/i);
});

test("askSystemOne posts state and questions verbatim and returns answers", async () => {
  const { fetchImpl, calls } = capturingFetch(() => jsonResponse({
    model: "jev-latest",
    answers: { urgent: { type: "noul", noul: 0.92 } },
    usage: { input_tokens: 12, output_tokens: 2 },
  }));
  const questions = { urgent: { type: "noul", instructions: "Does this convey urgency?" } };
  const state = { ticket: { messages: ["Payouts failing for 3 days"] } };

  const result = await askSystemOne({ state, questions, env: ENV, fetchImpl });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.typesafe.ai/v1/systemone");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.authorization, "Bearer ts-secret-key");
  assert.equal(calls[0].init.headers["content-type"], "application/json");
  assert.equal(calls[0].init.redirect, "error");
  assert.deepEqual(calls[0].body, { model: "jev-latest", state, questions });
  assert.deepEqual(result, {
    model: "jev-latest",
    answers: { urgent: { type: "noul", noul: 0.92 } },
    usage: { input_tokens: 12, output_tokens: 2 },
  });
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
    askSystemOne({ state: "s", questions: { a: { type: "noul", instructions: "?" } }, env: NO_KEY_ENV, fetchImpl }),
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
    text: async () => "{\"detail\":\"unknown question type\"}",
  });
  await assert.rejects(
    askSystemOne({ state: "s", questions: { a: { type: "noul", instructions: "?" } }, env: ENV, fetchImpl }),
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
    askSystemOne({ state: "s", questions: { a: { type: "noul", instructions: "?" } }, env: ENV, fetchImpl }),
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
    askSystemOne({ state: "s", questions: { a: { type: "noul", instructions: "?" } }, env: ENV, fetchImpl }),
    /invalid JSON/i,
  );
});

test("askSystemOne times out and aborts the request", async () => {
  let aborted = false;
  const fetchImpl = async (_url, init) => new Promise((_, reject) => {
    init.signal.addEventListener("abort", () => {
      aborted = true;
      reject(new Error("aborted"));
    }, { once: true });
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
  const fetchImpl = async (_url, init) => new Promise((_, reject) => {
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
      team: { type: "choice", choice: "technical", confidence: 0.82, probabilities: { billing: 0.08, technical: 0.85, sales: 0.07 } },
      risk: { type: "score", score: 1.6, confidence: 0.78, legend: { 0: "Low", 1: "Medium", 2: "High" }, probabilities: { 0: 0.05, 1: 0.3, 2: 0.65 } },
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
