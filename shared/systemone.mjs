// systemone.mjs — TypeSafe System One ("Jev") request logic.
//
// Shared by every extension that asks Jev and by the scripts/ classifiers.
// One transport, one set of validation and timeout rules, one place to fix a bug.
//
// Inside Pi, askSystemOne uses ctx.modelRegistry.classify() when a TypeSafe
// System One classifier is registered. The direct HTTPS POST remains the
// fallback when that registry is missing — every scripts/ entry point, and any
// host that has not registered the provider. bindSystemOne threads the Pi
// context through the extension handlers so the .mjs callers stay unchanged.
//
// Plain .mjs so node --test can cover it without a TS loader (see AGENTS.md).
// The extension entrypoint owns tool registration; everything here is pure
// request building, validation, transport and formatting so it stays testable.

import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { appendLedgerEntry, buildLedgerEntry } from "./jev-ledger.mjs";
import { redactSecrets } from "./redact.mjs";

const DEFAULT_BASE_URL = "https://api.typesafe.ai/v1";
// Pinned, not `jev-latest`: the guardrail, router, safe-compact and scripts/
// thresholds were measured on this version, and TypeSafe says to send a
// versioned ID once thresholds are tuned. Re-run scripts/judge-thresholds.mjs
// and scripts/replay-corpus.mjs on a new version before moving this pin.
const DEFAULT_MODEL = "jev-1.13.0";
const DEFAULT_TIMEOUT_MS = 30000;

const MAX_ERROR_BODY_CHARS = 300;

/**
 * TypeSafe asks for exponential backoff on 429 (rate limit) and 529
 * (overloaded): https://docs.typesafe.ai/api/errors.md. Without it a gate
 * that fails open skips its judgment on the first busy moment. Retries stay
 * inside the request timeout and the caller's abort signal.
 */
const RETRY_STATUSES = new Set([429, 529]);
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 500;

/** Jev's state limit. Past this the request fails whole, so it is refused here. */
const MAX_STATE_CHARS = 60_000;

const QUESTION_TYPES = new Set(["choice", "noul", "score"]);

function positiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function normalizeBaseUrl(value) {
  const raw = String(value ?? "").trim() || DEFAULT_BASE_URL;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`TYPESAFE_BASE_URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("TYPESAFE_BASE_URL must use http or https");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

/**
 * Candidate lore config paths, mirroring lore's own resolver
 * (lib/core/lore-paths.mjs): LORE_CONFIG, then LORE_HOME or
 * XDG_CONFIG_HOME/lore, with the legacy ~/.copilot fallback kept for installs
 * that have not been migrated.
 */
function loreConfigPaths(env) {
  const explicitConfig = typeof env?.LORE_CONFIG === "string" ? env.LORE_CONFIG.trim() : "";
  if (explicitConfig) {
    // An explicit override means that file, exactly as lore treats it: no
    // silent fallback that could authenticate with something else.
    return [explicitConfig];
  }
  const home = typeof env?.HOME === "string" && env.HOME.trim() ? env.HOME.trim() : homedir();
  const copilotHome =
    typeof env?.LORE_COPILOT_HOME === "string" && env.LORE_COPILOT_HOME.trim()
      ? env.LORE_COPILOT_HOME.trim()
      : join(home, ".copilot");
  const xdgHome = typeof env?.XDG_CONFIG_HOME === "string" ? env.XDG_CONFIG_HOME.trim() : "";
  const configHome = xdgHome && isAbsolute(xdgHome) ? xdgHome : join(home, ".config");
  const explicitHome = typeof env?.LORE_HOME === "string" ? env.LORE_HOME.trim() : "";
  const preferredHome = explicitHome || join(configHome, "lore");
  const preferredConfig = join(preferredHome, "lore.json");
  // lore only reads the pre-migration home while nothing has been migrated, so
  // a stale legacy key cannot shadow the current config.
  const legacy = !explicitHome && !existsSync(preferredConfig);
  return legacy ? [preferredConfig, join(copilotHome, "lore.json")] : [preferredConfig];
}

/**
 * Last-resort key source: the lore config. Returns the paths checked and any
 * parse failure so the caller can say what it looked at instead of blaming the
 * environment for a config typo.
 */
function apiKeySources(env) {
  const checked = loreConfigPaths(env);
  let parseError = null;
  for (const configPath of checked) {
    let raw;
    try {
      raw = readFileSync(configPath, "utf8");
    } catch {
      continue; // absent or unreadable: keep looking
    }
    try {
      const key = JSON.parse(raw)?.typesafe?.apiKey;
      if (typeof key === "string" && key.trim()) {
        return { key: key.trim(), checked, parseError };
      }
    } catch (error) {
      parseError = `${configPath}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  return { key: "", checked, parseError };
}

/**
 * The shared TypeSafe key, in precedence order: TYPESAFE_API_KEY, then
 * LORE_TYPESAFE_API_KEY, then the lore config file. Never throws.
 */
export function resolveApiKey(env = process.env) {
  const primaryKey = typeof env?.TYPESAFE_API_KEY === "string" ? env.TYPESAFE_API_KEY.trim() : "";
  const loreKey =
    typeof env?.LORE_TYPESAFE_API_KEY === "string" ? env.LORE_TYPESAFE_API_KEY.trim() : "";
  return primaryKey || loreKey || apiKeySources(env).key;
}

/** Resolve runtime configuration from the environment. */
export function resolveConfig(env = process.env) {
  const model = typeof env?.TYPESAFE_MODEL === "string" ? env.TYPESAFE_MODEL.trim() : "";
  return {
    apiKey: resolveApiKey(env),
    baseUrl: normalizeBaseUrl(env?.TYPESAFE_BASE_URL),
    model: model || DEFAULT_MODEL,
    timeoutMs: positiveInteger(env?.TYPESAFE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasInstructions(question) {
  const instructions = question?.instructions;
  if (typeof instructions === "string") {
    return instructions.trim().length > 0;
  }
  if (Array.isArray(instructions)) {
    return instructions.length > 0;
  }
  return isPlainObject(instructions) && Object.keys(instructions).length > 0;
}

/**
 * Validate a questions map before any network call. Throws with a message the
 * model can act on, because a malformed question is a caller bug, not a
 * provider failure.
 */
export function validateQuestions(questions) {
  if (!isPlainObject(questions) || Object.keys(questions).length === 0) {
    throw new Error("Provide at least one question in the questions map.");
  }
  for (const [id, question] of Object.entries(questions)) {
    if (!isPlainObject(question)) {
      throw new Error(`Question "${id}" must be an object with type, instructions and criteria.`);
    }
    if (!QUESTION_TYPES.has(question.type)) {
      throw new Error(
        `Question "${id}" has unknown question type "${question.type}". Use choice, noul or score.`,
      );
    }
    if (!hasInstructions(question)) {
      throw new Error(`Question "${id}" needs instructions — the actual judgment to make.`);
    }
    if (question.type === "choice") {
      if (!isPlainObject(question.criteria) || Object.keys(question.criteria).length < 2) {
        throw new Error(`Choice question "${id}" needs criteria with at least two options.`);
      }
    }
    if (question.type === "score") {
      if (!Array.isArray(question.criteria) || question.criteria.length < 2) {
        throw new Error(`Score question "${id}" needs criteria with at least two ordered levels.`);
      }
    }
  }
  return questions;
}

/**
 * Jev refuses a state past its limit, and the whole request fails with it — so
 * the size is refused here, before the round trip, where the message can name
 * the limit and the actual size instead of an error body that says the same
 * thing less clearly, and without paying for a request that cannot succeed.
 */
export function validateState(state) {
  const size = JSON.stringify(state ?? {}).length;
  if (size > MAX_STATE_CHARS) {
    throw new Error(
      `TypeSafe state is ${size} characters; the limit is ${MAX_STATE_CHARS}. Send less per request.`,
    );
  }
}

/**
 * A state reaches the model as JSON, and JSON has no way to say "undefined", a
 * function, or a Map: those keys arrive absent, so a question that names one is
 * answered from an empty state and the caller reads the null as "keep". Report
 * the first value that would not survive the trip, by path.
 */
function stateProblem(value, path, seen = new Set()) {
  if (value === null) return null;
  const type = typeof value;
  if (type === "string" || type === "boolean") return null;
  if (type === "number") {
    return Number.isFinite(value) ? null : `${path} is ${value}, which JSON turns into null`;
  }
  if (type === "undefined") return `${path} is undefined, which JSON drops`;
  if (type !== "object") return `${path} is a ${type}, which JSON drops`;
  if (seen.has(value)) return `${path} is circular, which JSON cannot serialize`;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const problem = stateProblem(item, `${path}[${index}]`, seen);
      if (problem) return problem;
    }
    return null;
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    const name = value.constructor?.name ?? "non-plain object";
    return `${path} is a ${name}, which JSON serializes as {}`;
  }
  for (const [key, item] of Object.entries(value)) {
    const problem = stateProblem(item, `${path}.${key}`, seen);
    if (problem) return problem;
  }
  return null;
}

/** A backticked reference in a question: the way these prompts name their input. */
const REFERENCE = /`([^`\n]+)`/g;
const REFERENCE_SHAPE = /^[A-Za-z_$][\w$]*(\.[\w$]+)*$/;

/** Every string in a question that could name a state path. */
function questionStrings(question) {
  const parts = [question?.instructions];
  const criteria = question?.criteria;
  if (Array.isArray(criteria)) parts.push(...criteria);
  else if (criteria && typeof criteria === "object") parts.push(...Object.values(criteria));
  return parts.filter((part) => typeof part === "string");
}

/**
 * A question that names a path the state does not have is answered from nothing,
 * and the caller cannot tell that from a considered "no". Backticked names are
 * how these prompts refer to their input, so a reference that starts at a
 * top-level key of the state has to resolve all the way down.
 */
export function validateReferences(state, questions) {
  const keys = Object.keys(isPlainObject(state) ? state : {});
  for (const [id, question] of Object.entries(questions)) {
    for (const text of questionStrings(question)) {
      for (const match of text.matchAll(REFERENCE)) {
        const reference = match[1].trim();
        if (!REFERENCE_SHAPE.test(reference)) continue;
        const parts = reference.split(".");
        // References to things that are not state — a disposition name, a file
        // path, a command — are none of this check's business.
        if (!keys.includes(parts[0])) continue;
        let node = state;
        let walked = "";
        for (const part of parts) {
          walked = walked ? `${walked}.${part}` : part;
          if (node === null || typeof node !== "object" || !(part in node)) {
            throw new Error(
              `Question "${id}" refers to \`${reference}\`, and the state has no \`${walked}\`. ` +
                `The state has: ${keys.join(", ")}.`,
            );
          }
          node = node[part];
        }
      }
    }
  }
  return questions;
}

/**
 * Everything a request needs to be true before it is worth sending: the
 * questions, the size of the state, whether the state survives JSON, and
 * whether the questions name what the state holds. Called by askSystemOne and
 * by the sweeps that check every call site in this repo.
 */
export function validateRequest({ state, questions } = {}) {
  validateQuestions(questions);
  validateState(state);
  const problem = stateProblem(state ?? {}, "state");
  if (problem) throw new Error(`${problem}. Use null for an absent value.`);
  validateReferences(state ?? {}, questions);
  return { state, questions };
}

async function readErrorBody(response) {
  if (typeof response?.text !== "function") {
    return "";
  }
  try {
    const body = String(await response.text()).trim();
    return body ? `: ${body.slice(0, MAX_ERROR_BODY_CHARS)}` : "";
  } catch {
    return "";
  }
}

/** Wait `ms`, or reject as soon as `signal` aborts. */
function backoff(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** The extension context for the in-flight Pi handler, plus classify usage. */
const systemOneAls = new AsyncLocalStorage();

function missingKeyError(env) {
  const sources = apiKeySources(env);
  const detail = sources.parseError ? ` (unreadable config: ${sources.parseError})` : "";
  return new Error(
    `TYPESAFE_API_KEY is not set. Set it in the environment or as typesafe.apiKey in ${sources.checked.join(" or ")}${detail}.`,
  );
}

function isSystemOneClassifier(model) {
  return (
    !!model &&
    model.type === "classifier" &&
    model.provider === "typesafe" &&
    model.api === "typesafe-system-one"
  );
}

/** An explicit base URL (proxy, smoke fixture). Unset keeps the catalog host. */
function configuredBaseUrl(env, config) {
  const raw = typeof env?.TYPESAFE_BASE_URL === "string" ? env.TYPESAFE_BASE_URL.trim() : "";
  return raw ? config.baseUrl : null;
}

/**
 * The TypeSafe System One model Pi should classify with.
 *
 * Stock Pi registers `jev-latest`, not the pinned id. Cloning the catalog
 * model and rewriting `id` keeps auth, base URL and the classify implementation
 * while the wire payload stays on the version the thresholds were measured on.
 * Returns null when nothing registered can serve this call, which is the
 * signal to use the direct HTTP transport.
 */
function selectClassifier(registry, requestedModel, baseUrl) {
  if (!registry || typeof registry.classify !== "function") return null;
  let model = null;
  if (typeof registry.findOfType === "function") {
    const exact = registry.findOfType("classifier", "typesafe", requestedModel);
    if (isSystemOneClassifier(exact)) model = exact;
  }
  if (!model && typeof registry.getModelsOfType === "function") {
    const models = registry.getModelsOfType("classifier", "typesafe");
    if (Array.isArray(models)) {
      model = models.find((candidate) => isSystemOneClassifier(candidate)) ?? null;
    }
  }
  if (!model) return null;
  const cloned = { ...model, id: requestedModel };
  if (baseUrl) cloned.baseUrl = baseUrl;
  return cloned;
}

function mapPiAnswers(answers) {
  if (!isPlainObject(answers)) return {};
  const mapped = {};
  for (const [id, answer] of Object.entries(answers)) {
    // Pi rewrites wire `noul` to `{ type: "bool", probability }`. Callers still
    // route on `type: "noul"` and `answer.noul`.
    mapped[id] = answer?.type === "bool" ? { type: "noul", noul: answer.probability } : answer;
  }
  return mapped;
}

function mapPiUsage(usage) {
  if (!isPlainObject(usage)) return null;
  if ("input_tokens" in usage || "output_tokens" in usage) return usage;
  if (typeof usage.input === "number" || typeof usage.output === "number") {
    return { input_tokens: usage.input ?? 0, output_tokens: usage.output ?? 0 };
  }
  return null;
}

async function readJsonClone(response) {
  if (!response || typeof response.clone !== "function") return undefined;
  try {
    const cloned = response.clone();
    if (!cloned || typeof cloned.json !== "function") return undefined;
    const payload = await cloned.json();
    return isPlainObject(payload) ? payload : undefined;
  } catch {
    return undefined;
  }
}

function classifyFailure(result, config, env) {
  const message =
    typeof result?.errorMessage === "string" && result.errorMessage.trim()
      ? result.errorMessage
      : `TypeSafe classify failed (${result?.stopReason ?? "unknown"})`;
  // Pi's own auth error, and only when we had nothing to pass in. A local key
  // that Pi rejected should stay Pi's message.
  if (!config.apiKey && /no api key|not configured|api key/i.test(message)) {
    return missingKeyError(env);
  }
  return new Error(message);
}

function emptySessionUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function addSessionUsage(total, usage) {
  total.input += usage.input || 0;
  total.output += usage.output || 0;
  total.cacheRead += usage.cacheRead || 0;
  total.cacheWrite += usage.cacheWrite || 0;
  total.totalTokens += usage.totalTokens || 0;
  const cost = isPlainObject(usage.cost) ? usage.cost : {};
  total.cost.input += cost.input || 0;
  total.cost.output += cost.output || 0;
  total.cost.cacheRead += cost.cacheRead || 0;
  total.cost.cacheWrite += cost.cacheWrite || 0;
  total.cost.total += cost.total || 0;
}

function recordSessionUsage(usage) {
  const bucket = systemOneAls.getStore()?.usage;
  if (!bucket || !isPlainObject(usage) || typeof usage.input !== "number") return;
  bucket.push(usage);
}

function takeSessionUsage() {
  const bucket = systemOneAls.getStore()?.usage;
  if (!bucket?.length) return undefined;
  const total = emptySessionUsage();
  for (const usage of bucket) addSessionUsage(total, usage);
  bucket.length = 0;
  return total;
}

function combineUsage(left, right) {
  if (!isPlainObject(left)) return right;
  if (!isPlainObject(right)) return left;
  const total = emptySessionUsage();
  addSessionUsage(total, left);
  addSessionUsage(total, right);
  return total;
}

/**
 * Pi's tool_result handler replaces `event.usage` with whatever the handler
 * returns. Jev's tokens have to be added to the tool's own usage, including
 * when the handler returns nothing — otherwise a nudge drops the failed
 * call's cost. Tool execute has the same trap when `result.usage` is already
 * set.
 */
function withSessionUsage(result, priorUsage) {
  const jev = takeSessionUsage();
  if (!jev) return result;
  const combined = combineUsage(priorUsage, jev);
  if (result == null || typeof result !== "object" || Array.isArray(result)) {
    return { usage: combined };
  }
  const own = isPlainObject(result.usage) && result.usage !== priorUsage ? result.usage : undefined;
  return { ...result, usage: own ? combineUsage(combined, own) : combined };
}

/**
 * Run `fn` where askSystemOne can see `ctx.modelRegistry`. Nested calls share
 * the outer usage bucket. `attachUsage` copies Pi-shaped classify usage onto a
 * returned tool result; compaction drafts use `compactionUsage` instead,
 * because that usage belongs on the entry Pi actually records.
 */
function runWithSystemOneContext(ctx, fn, { attachUsage = false, priorUsage, pi } = {}) {
  const parent = systemOneAls.getStore();
  const usage = parent?.usage ?? [];
  return systemOneAls.run({ ctx: ctx ?? parent?.ctx, pi: pi ?? parent?.pi, usage }, async () => {
    const result = await fn();
    if (!attachUsage || parent?.usage) return result;
    return withSessionUsage(result, priorUsage);
  });
}

/** Put this turn's classify usage on a compaction draft, when there is any. */
export function compactionUsage(entry) {
  const usage = takeSessionUsage();
  if (!usage || !entry || typeof entry !== "object" || Array.isArray(entry) || entry.usage) {
    return entry;
  }
  return { ...entry, usage };
}

/**
 * Thread the Pi context into every handler this extension registers.
 *
 * Called before the extension's own `on` / `registerTool` / `registerCommand`
 * / `registerVirtualModel`. The .mjs judges keep calling `askSystemOne()`
 * with no context argument; the registry arrives through the async store, so
 * it never becomes part of a memo key.
 */
export function bindSystemOne(pi) {
  if (!pi || typeof pi !== "object") return pi;
  if (typeof pi.on === "function") {
    const originalOn = pi.on.bind(pi);
    pi.on = (event, handler) =>
      originalOn(event, (payload, ctx) =>
        runWithSystemOneContext(ctx, () => handler(payload, ctx), {
          attachUsage: event === "tool_result",
          priorUsage: event === "tool_result" ? payload?.usage : undefined,
          pi,
        }),
      );
  }
  if (typeof pi.registerTool === "function") {
    const originalRegisterTool = pi.registerTool.bind(pi);
    pi.registerTool = (def) =>
      originalRegisterTool({
        ...def,
        execute:
          typeof def?.execute === "function"
            ? (...args) =>
                runWithSystemOneContext(args[4], () => def.execute(...args), { attachUsage: true })
            : def?.execute,
      });
  }
  if (typeof pi.registerCommand === "function") {
    const originalRegisterCommand = pi.registerCommand.bind(pi);
    pi.registerCommand = (name, def) =>
      originalRegisterCommand(
        name,
        def && typeof def.handler === "function"
          ? {
              ...def,
              handler: (...args) => runWithSystemOneContext(args[1], () => def.handler(...args)),
            }
          : def,
      );
  }
  if (typeof pi.registerVirtualModel === "function") {
    const originalRegisterVirtualModel = pi.registerVirtualModel.bind(pi);
    pi.registerVirtualModel = (def) =>
      originalRegisterVirtualModel(
        def && typeof def.route === "function"
          ? {
              ...def,
              route: (request, ctx) => runWithSystemOneContext(ctx, () => def.route(request, ctx)),
            }
          : def,
      );
  }
  return pi;
}

/** Pi's stored provider key. Used only as a redaction literal, never as a request. */
async function storedProviderKey(registry) {
  if (typeof registry?.getApiKeyForProvider !== "function") return "";
  try {
    const key = await registry.getApiKeyForProvider("typesafe");
    return typeof key === "string" ? key.trim() : "";
  } catch {
    return "";
  }
}

function reportedModel(payload, result, requestedModel) {
  if (typeof payload?.model === "string" && payload.model.trim()) return payload.model;
  if (typeof result?.model === "string" && result.model.trim()) return result.model;
  return requestedModel;
}

function countedRedactions(redactions, privacyCount) {
  return {
    redactions,
    ...(privacyCount > 0 ? { privacyRedactions: privacyCount } : {}),
  };
}

async function askViaClassify({
  registry,
  classifier,
  safeState,
  questions,
  redactions,
  privacyCount,
  requestedModel,
  config,
  env,
  fetchImpl,
  signal,
  retryDelayMs,
}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.timeoutMs);
  const forwardAbort = () => controller.abort(signal?.reason);
  const captured = { payload: undefined };
  try {
    if (signal?.aborted) throw new Error("TypeSafe request aborted");
    if (signal) signal.addEventListener("abort", forwardAbort, { once: true });
    // maxRetries: 0 keeps Pi from applying its own policy: 408, 409, other
    // 5xx, and a Retry-After that can outlast this call. The loop below is
    // the same 429/529 schedule as the direct HTTP transport.
    const fetchWrapper = async (url, init) => {
      let response;
      let attempt = 0;
      for (;;) {
        response = await fetchImpl(url, { ...init, redirect: "error" });
        if (response?.ok || !RETRY_STATUSES.has(response?.status) || attempt >= MAX_RETRIES) break;
        await readErrorBody(response);
        await backoff(retryDelayMs * 2 ** attempt, controller.signal);
        attempt++;
      }
      // Pi parses noul into bool and drops score probabilities. The raw body
      // of a successful response is what every gate already knows how to read.
      if (response?.ok) captured.payload = await readJsonClone(response);
      return response;
    };
    let result;
    try {
      result = await registry.classify(
        classifier,
        { state: safeState, questions },
        {
          signal: controller.signal,
          maxRetries: 0,
          fetch: fetchWrapper,
          headers: { "User-Agent": null },
          ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        },
      );
    } catch (error) {
      if (timedOut) {
        throw new Error(`TypeSafe request timed out after ${config.timeoutMs}ms`, { cause: error });
      }
      if (signal?.aborted) throw new Error("TypeSafe request aborted", { cause: error });
      throw error;
    }
    if (timedOut) throw new Error(`TypeSafe request timed out after ${config.timeoutMs}ms`);
    if (signal?.aborted || result?.stopReason === "aborted") {
      throw new Error("TypeSafe request aborted");
    }
    const payload = captured.payload;
    // Pi rejects a 200 that omits one question (`did not return an answer`).
    // The HTTP transport returns that body, and the request was already billed.
    const partial =
      result?.stopReason !== "stop" &&
      /did not return an answer/i.test(result?.errorMessage ?? "") &&
      isPlainObject(payload?.answers);
    if (result?.stopReason !== "stop" && !partial) throw classifyFailure(result, config, env);
    recordSessionUsage(result?.usage);
    return {
      model: reportedModel(payload, result, requestedModel),
      answers: isPlainObject(payload?.answers) ? payload.answers : mapPiAnswers(result?.answers),
      usage: isPlainObject(payload?.usage) ? payload.usage : mapPiUsage(result?.usage),
      ...countedRedactions(redactions, privacyCount),
    };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", forwardAbort);
  }
}

async function askOverHttp({
  config,
  requestedModel,
  safeState,
  questions,
  redactions,
  privacyCount,
  fetchImpl,
  signal,
  retryDelayMs,
}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.timeoutMs);
  const forwardAbort = () => controller.abort(signal?.reason);

  try {
    if (signal?.aborted) throw new Error("TypeSafe request aborted");
    if (signal) signal.addEventListener("abort", forwardAbort, { once: true });
    const body = JSON.stringify({ model: requestedModel, state: safeState, questions });
    let response;
    let attempt = 0;
    for (;;) {
      response = await fetchImpl(`${config.baseUrl}/systemone`, {
        method: "POST",
        // No TypeSafe-Danger-Zone-Images header: TypeSafe wants it only on
        // requests that carry images (`assets`), and this transport sends none.
        headers: {
          authorization: `Bearer ${config.apiKey}`,
          "content-type": "application/json",
        },
        body,
        // Fixed remote host: refusing redirects keeps state and the bearer
        // token from following an unexpected Location.
        redirect: "error",
        signal: controller.signal,
      });
      if (response?.ok || !RETRY_STATUSES.has(response?.status) || attempt >= MAX_RETRIES) break;
      await readErrorBody(response); // drain before retrying
      await backoff(retryDelayMs * 2 ** attempt, controller.signal);
      attempt++;
    }
    if (!response?.ok) {
      const detail = await readErrorBody(response);
      const tries = attempt > 0 ? ` after ${attempt + 1} attempts` : "";
      throw new Error(
        `TypeSafe request failed with status ${response?.status ?? "unknown"}${tries}${detail}`,
      );
    }
    let payload;
    try {
      payload = await response.json();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`TypeSafe returned invalid JSON: ${message}`, { cause: error });
    }
    return {
      model: reportedModel(payload, null, requestedModel),
      answers: isPlainObject(payload?.answers) ? payload.answers : {},
      usage: isPlainObject(payload?.usage) ? payload.usage : null,
      ...countedRedactions(redactions, privacyCount),
    };
  } catch (error) {
    if (timedOut) {
      throw new Error(`TypeSafe request timed out after ${config.timeoutMs}ms`, { cause: error });
    }
    if (signal?.aborted) throw new Error("TypeSafe request aborted", { cause: error });
    throw error;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener("abort", forwardAbort);
  }
}

/**
 * Ask TypeSafe's System One model one or more typed questions about `state`.
 *
 * Uses Pi's classifier when `ctx` (or the context bound by `bindSystemOne`)
 * has a TypeSafe System One model. Otherwise posts to `/systemone` directly.
 *
 * @param {{ state: unknown, questions: object, model?: string, env?: object, fetchImpl?: typeof fetch, signal?: AbortSignal, retryDelayMs?: number, ctx?: object, feature?: string }} opts
 * @returns {Promise<{ model: string, answers: object, usage: object | null, redactions: number, privacyRedactions?: number }>}
 */
export async function askSystemOne({
  state,
  questions,
  model,
  env = process.env,
  fetchImpl = globalThis.fetch,
  signal,
  retryDelayMs = RETRY_BASE_MS,
  ctx,
  feature,
} = {}) {
  const started = Date.now();
  const sessionPi = systemOneAls.getStore()?.pi;
  const config = resolveConfig(env);
  const requestedModel = typeof model === "string" && model.trim() ? model.trim() : config.model;
  const registry = (ctx ?? systemOneAls.getStore()?.ctx)?.modelRegistry;
  const classifier = selectClassifier(registry, requestedModel, configuredBaseUrl(env, config));
  // Redact before validating: the size and shape checks should describe what
  // would actually be sent, and a secret is not what makes a request too big.
  // The local key is not the only credential that can sit in the state. On the
  // classify path Pi may also hold a stored TypeSafe key that never appears in
  // the environment.
  const literals = [config.apiKey];
  if (classifier) {
    const stored = await storedProviderKey(registry);
    if (stored) literals.push(stored);
  }
  // One masked copy, before either transport. Home paths are masked by default;
  // emails only when PI_MASK_EMAILS=1. Credential redactions stay a separate count.
  const {
    value: safeState,
    count: redactions,
    privacyCount = 0,
  } = redactSecrets(state, {
    literals,
    maskEmails: env?.PI_MASK_EMAILS === "1",
  });
  validateRequest({ state: safeState, questions });
  // Nothing is sent without a local key. Pi's stored login is not a substitute;
  // that can be an opt-in later. The HTTP path already refused here.
  if (!config.apiKey) throw missingKeyError(env);
  const record = (result, transport) => {
    appendLedgerEntry(
      sessionPi,
      buildLedgerEntry({
        feature: typeof feature === "string" && feature.trim() ? feature.trim() : "unknown",
        model: result.model,
        requestedModel,
        questions,
        answers: result.answers,
        latencyMs: Date.now() - started,
        transport,
        redactions,
        privacyRedactions: privacyCount,
        outcome: "ok",
        literals,
      }),
    );
    return result;
  };
  if (classifier) {
    return record(
      await askViaClassify({
        registry,
        classifier,
        safeState,
        questions,
        redactions,
        privacyCount,
        requestedModel,
        config,
        env,
        fetchImpl,
        signal,
        retryDelayMs,
      }),
      "classify",
    );
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("A fetch implementation is required to call TypeSafe.");
  }
  return record(
    await askOverHttp({
      config,
      requestedModel,
      safeState,
      questions,
      redactions,
      privacyCount,
      fetchImpl,
      signal,
      retryDelayMs,
    }),
    "http",
  );
}

function formatProbabilities(probabilities, legend) {
  const entries = Object.entries(probabilities ?? {});
  // Score levels come back keyed "0".."n" — keep numeric order and label them.
  const numeric = entries.every(([key]) => /^\d+$/.test(key));
  const ordered = numeric
    ? [...entries].sort((left, right) => Number(left[0]) - Number(right[0]))
    : [...entries].sort((left, right) => Number(right[1]) - Number(left[1]));
  return ordered
    .map(([key, value]) => {
      const probability = Number(value).toFixed(2);
      return numeric && legend?.[key]
        ? `${key}=${legend[key]} (${probability})`
        : `${key}=${probability}`;
    })
    .join(" ");
}

/**
 * A number the answer actually gave, or null when it gave none.
 *
 * Number(null) and Number("") are both 0, and 0 is a real reading — so an
 * absent value must never come back as a confident zero. Every caller routes
 * "below the threshold" and "no answer" to opposite decisions, which is why
 * this is one function rather than a copy per package.
 */
export function usableNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "string" && !value.trim()) {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

/** Render answers as compact text for the model to read. */
export function formatAnswers({ model, usage, answers, redactions, privacyRedactions } = {}) {
  const lines = [];
  const tokens = usage
    ? `input_tokens=${usage.input_tokens ?? "?"} output_tokens=${usage.output_tokens ?? "?"}`
    : "usage unavailable";
  // A redaction changes what the model was shown, so it belongs next to the
  // answer it shaped rather than in a log nobody reads.
  const totalRedactions = (redactions ?? 0) + (privacyRedactions ?? 0);
  const redacted = totalRedactions > 0 ? ` · ${totalRedactions} redacted` : "";
  lines.push(`${model ?? DEFAULT_MODEL} (${tokens})${redacted}`);
  const entries = Object.entries(answers ?? {});
  if (entries.length === 0) {
    lines.push("(no answers)");
    return lines.join("\n");
  }
  for (const [id, answer] of entries) {
    if (answer?.type === "noul") {
      const value = usableNumber(answer.noul);
      lines.push(
        value === null
          ? `${id}: unusable answer (no noul value)`
          : `${id}: noul ${value.toFixed(2)}`,
      );
      continue;
    }
    if (answer?.type === "choice") {
      if (typeof answer.choice !== "string" || !answer.choice.trim()) {
        lines.push(`${id}: unusable answer (no choice value)`);
        continue;
      }
      const confidence = Number.isFinite(Number(answer.confidence))
        ? ` (confidence ${Number(answer.confidence).toFixed(2)})`
        : "";
      lines.push(`${id}: choice "${answer.choice}"${confidence}`);
      const probabilities = formatProbabilities(answer.probabilities);
      if (probabilities) {
        lines.push(`  probabilities: ${probabilities}`);
      }
      continue;
    }
    if (answer?.type === "score") {
      const value = usableNumber(answer.score);
      if (value === null) {
        lines.push(`${id}: unusable answer (no score value)`);
        continue;
      }
      const confidence = Number.isFinite(Number(answer.confidence))
        ? ` (confidence ${Number(answer.confidence).toFixed(2)})`
        : "";
      lines.push(`${id}: score ${value.toFixed(2)}${confidence}`);
      const probabilities = formatProbabilities(answer.probabilities, answer.legend);
      if (probabilities) {
        lines.push(`  probabilities: ${probabilities}`);
      }
      continue;
    }
    lines.push(`${id}: ${JSON.stringify(answer)}`);
  }
  return lines.join("\n");
}
